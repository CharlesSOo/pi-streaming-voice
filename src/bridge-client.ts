/**
 * The remote side of the voice bridge: pi on a server reaches the Mac's microphone through a Rex forward on a
 * loopback port. Only text comes back.
 */
import { existsSync, readFileSync, statSync } from "node:fs";
import { connect, isIP, type Socket } from "node:net";
import { join } from "node:path";
import {
  AUTH_TIMEOUT_MS,
  authMac,
  BRIDGE_LINE_LIMIT,
  encode,
  isToken,
  LineReader,
  macEquals,
  newNonce,
  parseBridgeMessage,
  type BridgeMessage,
  type ClientMessage,
} from "./bridge-protocol.ts";
import type { Transcriber, TranscriberCallbacks } from "./transcriber.ts";

export const BRIDGE_CONFIG_FILENAME = "pi-streaming-voice-bridge.json";
export const BRIDGE_TOKEN_FILENAME = "pi-streaming-voice-bridge.token";
/** How long to wait for the last words after `stop`. */
const DONE_TIMEOUT_MS = 8_000;

export interface BridgeClientConfig {
  /** Where the bridge is: 127.0.0.1 (a Rex forward), or the Mac's Tailscale address. */
  host?: string;
  port: number;
  token: string;
}

export function bridgeTokenPath(agentDir: string): string {
  return join(agentDir, BRIDGE_TOKEN_FILENAME);
}

export function bridgeConfigPath(agentDir: string): string {
  return join(agentDir, BRIDGE_CONFIG_FILENAME);
}

/** Set up for the bridge on this host (the token file is there). */
export function bridgeConfigured(agentDir: string): boolean {
  return existsSync(bridgeTokenPath(agentDir));
}

/** Port and token, checked. Throws with a message for the user. */
export function loadBridgeConfig(agentDir: string): BridgeClientConfig {
  const configPath = bridgeConfigPath(agentDir);
  let port: unknown;
  let host: unknown;
  try {
    ({ port, host } = JSON.parse(readFileSync(configPath, "utf8")) as { port?: unknown; host?: unknown });
  } catch {
    throw new Error(`Voice bridge: cannot read ${configPath}`);
  }
  if (host !== undefined && (typeof host !== "string" || isIP(host) === 0)) throw new Error(`Voice bridge: "host" in ${configPath} must be an IP address`);
  if (typeof port !== "number" || !Number.isInteger(port) || port < 1 || port > 65535) {
    throw new Error(`Voice bridge: no valid "port" in ${configPath}`);
  }
  const tokenPath = bridgeTokenPath(agentDir);
  let token: string;
  try {
    // Others on this host must not be able to read it.
    if ((statSync(tokenPath).mode & 0o077) !== 0) {
      throw new Error(`Voice bridge: ${tokenPath} is readable by other users; run chmod 600 on it`);
    }
    token = readFileSync(tokenPath, "utf8").trim();
  } catch (error) {
    if (error instanceof Error && error.message.startsWith("Voice bridge:")) throw error;
    throw new Error(`Voice bridge: cannot read ${tokenPath}`);
  }
  if (!isToken(token)) throw new Error(`Voice bridge: ${tokenPath} does not hold a valid token`);
  return { ...(typeof host === "string" && { host }), port, token };
}

export interface BridgeClientOptions {
  authTimeoutMs?: number;
  doneTimeoutMs?: number;
  /** First reconnect delay after a failed or dropped warm connection; doubles up to `maxBackoffMs`. */
  backoffMs?: number;
  maxBackoffMs?: number;
}

/** An authenticated connection to the bridge, holding no device until `start`. */
export interface BridgeLink {
  readonly where: string;
  send(msg: ClientMessage): void;
  /** Lines after the handshake, parsed (undefined = off-schema). */
  onMessage: ((msg: BridgeMessage | undefined) => void) | undefined;
  onClose: (() => void) | undefined;
  readonly closed: boolean;
  close(): void;
}

/** Connect and run the mutual handshake. Rejects with a message for the user. */
export function handshake(config: BridgeClientConfig, timeoutMs = AUTH_TIMEOUT_MS): Promise<BridgeLink> {
  const host = config.host ?? "127.0.0.1";
  const where = `${host}:${config.port}`;
  return new Promise<BridgeLink>((resolve, reject) => {
    const clientNonce = newNonce();
    let bridgeNonce: string | undefined;
    let phase: "hello" | "ok" | "linked" | "failed" = "hello";
    const socket: Socket = connect({ host, port: config.port });
    socket.setNoDelay(true);
    const unreachable = `Voice bridge not reachable on ${where}: is the Mac bridge running?`;
    const link: BridgeLink & { closed: boolean } = {
      where,
      closed: false,
      onMessage: undefined,
      onClose: undefined,
      send: (msg) => {
        if (socket.writable) socket.write(encode(msg));
      },
      close: () => {
        socket.destroy();
      },
    };
    const fail = (message: string) => {
      clearTimeout(timer);
      if (phase === "linked" || phase === "failed") return;
      phase = "failed";
      reader.stop();
      socket.destroy();
      reject(new Error(message));
    };
    const timer = setTimeout(() => {
      fail(bridgeNonce ? `Voice bridge on ${where} did not finish the handshake in time` : unreachable);
    }, timeoutMs);
    const reader = new LineReader(BRIDGE_LINE_LIMIT, (line) => {
      const msg = parseBridgeMessage(line);
      if (phase === "hello") {
        if (msg?.t !== "hello") return fail(`Voice bridge on ${where} sent something unexpected`);
        bridgeNonce = msg.nonce;
        phase = "ok";
        link.send({ t: "auth", nonce: clientNonce, mac: authMac(config.token, "client", msg.nonce, clientNonce) });
        return;
      }
      if (phase === "ok") {
        // Whoever answers must prove it knows the token too, or nothing it sends is used.
        if (msg?.t !== "ok" || !macEquals(authMac(config.token, "bridge", bridgeNonce ?? "", clientNonce), msg.mac)) {
          return fail(`Voice bridge on ${where} failed authentication: something else may be listening on that port`);
        }
        clearTimeout(timer);
        phase = "linked";
        resolve(link);
        return;
      }
      if (phase === "linked") link.onMessage?.(msg);
    });
    socket.on("data", (chunk: Buffer) => {
      if (reader.push(chunk)) return;
      if (phase === "linked") {
        link.onMessage?.(undefined);
        socket.destroy();
      } else fail(`Voice bridge on ${where} sent something unexpected`);
    });
    socket.on("error", () => undefined);
    socket.on("close", () => {
      if (phase === "hello") fail(unreachable);
      else if (phase === "ok") fail(`Voice bridge on ${where} refused the connection: check the token in ${BRIDGE_TOKEN_FILENAME}`);
      else if (phase === "linked") {
        link.closed = true;
        reader.stop();
        link.onClose?.();
      }
    });
  });
}

/**
 * Keeps one authenticated, idle connection to the bridge, so a take only has to send `start`: a new connection
 * through a Rex tunnel takes seconds. Reconnects after each take and after a drop, backing off quietly while the
 * bridge is down; errors reach the user only when a take asks for the link.
 */
export class BridgeConnector {
  private ready: BridgeLink | undefined;
  private pending: Promise<BridgeLink> | undefined;
  private timer: ReturnType<typeof setTimeout> | undefined;
  private backoff: number;
  private disposed = false;
  private readonly loadConfig: () => BridgeClientConfig;
  readonly opts: Required<BridgeClientOptions>;

  constructor(loadConfig: () => BridgeClientConfig, opts: BridgeClientOptions = {}) {
    this.loadConfig = loadConfig;
    this.opts = {
      authTimeoutMs: opts.authTimeoutMs ?? AUTH_TIMEOUT_MS,
      doneTimeoutMs: opts.doneTimeoutMs ?? DONE_TIMEOUT_MS,
      backoffMs: opts.backoffMs ?? 1_000,
      maxBackoffMs: opts.maxBackoffMs ?? 30_000,
    };
    this.backoff = this.opts.backoffMs;
  }

  /** Have a warm link, or one on its way. */
  warm(): void {
    if (this.disposed || this.ready || this.pending || this.timer) return;
    void this.connect().catch(() => this.retryLater());
  }

  /** Whether a warm link is ready right now (for tests and diagnostics). */
  get isWarm(): boolean {
    return this.ready !== undefined;
  }

  /** The warm link for a take (waiting for one being set up); connects now if there is none. */
  async acquire(): Promise<BridgeLink> {
    if (this.disposed) throw new Error("Voice bridge connection is shut down");
    if (!this.ready && !this.pending) {
      if (this.timer) clearTimeout(this.timer);
      this.timer = undefined;
      // A take was asked for: try at once, and say why if it fails.
      void this.connect().catch(() => this.retryLater());
    }
    const link = this.ready ?? (await this.pending!);
    if (this.ready === link) this.ready = undefined;
    else if (link.closed) return this.acquire();
    // When this take's connection closes, set up the next warm one straight away.
    link.onClose = () => {
      this.backoff = this.opts.backoffMs;
      this.warm();
    };
    link.onMessage = undefined;
    return link;
  }

  dispose(): void {
    this.disposed = true;
    if (this.timer) clearTimeout(this.timer);
    this.timer = undefined;
    this.ready?.close();
    this.ready = undefined;
  }

  private connect(): Promise<BridgeLink> {
    const pending = (async () => {
      const link = await handshake(this.loadConfig(), this.opts.authTimeoutMs);
      return link;
    })();
    this.pending = pending;
    pending.then(
      (link) => {
        if (this.pending === pending) this.pending = undefined;
        if (this.disposed) {
          link.close();
          return;
        }
        this.backoff = this.opts.backoffMs;
        this.ready = link;
        // Nothing should arrive on an idle link; a drop means the bridge or the tunnel went away.
        link.onMessage = () => link.close();
        link.onClose = () => {
          if (this.ready === link) this.ready = undefined;
          this.retryLater();
        };
      },
      () => {
        if (this.pending === pending) this.pending = undefined;
      },
    );
    return pending;
  }

  private retryLater(): void {
    if (this.disposed || this.ready || this.pending || this.timer) return;
    const delay = this.backoff;
    this.backoff = Math.min(this.backoff * 2, this.opts.maxBackoffMs);
    this.timer = setTimeout(() => {
      this.timer = undefined;
      this.warm();
    }, delay);
  }
}

type State = "idle" | "active" | "finishing" | "over";

/** A take through the voice bridge, on the connector's warm link. */
export class BridgeTranscriber implements Transcriber {
  private link: BridgeLink | undefined;
  private state: State = "idle";
  private cb: TranscriberCallbacks | undefined;
  private doneWaiter: ((finalized: boolean) => void) | undefined;
  private readonly connector: BridgeConnector;

  constructor(connector: BridgeConnector) {
    this.connector = connector;
  }

  async start(cb: TranscriberCallbacks): Promise<void> {
    this.cb = cb;
    const link = await this.connector.acquire();
    if (this.state === "over") {
      link.close();
      return;
    }
    this.link = link;
    this.state = "active";
    link.onMessage = (msg) => (msg ? this.handle(msg) : this.lose("Voice bridge sent something unexpected"));
    const next = link.onClose;
    link.onClose = () => {
      next?.();
      this.lose("Lost the connection to the voice bridge");
    };
    link.send({ t: "start" });
  }

  private handle(msg: BridgeMessage): void {
    const cb = this.cb;
    if (!cb || this.state === "over") return;
    switch (msg.t) {
      case "listening":
        cb.onListening();
        return;
      case "level":
        cb.onLevel(msg.v);
        return;
      case "interim":
        cb.onInterim(msg.text);
        return;
      case "final":
        cb.onFinal(msg.text);
        return;
      case "done":
        if (this.state !== "finishing") return this.lose("Voice bridge ended the take unexpectedly");
        this.state = "over";
        this.link?.close();
        this.resolveDone(msg.finalized);
        return;
      case "error":
        this.lose(msg.code === "busy" ? "Voice bridge is busy with a take from another session" : msg.message);
        return;
      default:
        this.lose("Voice bridge sent something unexpected");
    }
  }

  /** The take cannot go on: report once, close. */
  private lose(message: string): void {
    if (this.state === "over") return;
    const wasFinishing = this.state === "finishing";
    this.state = "over";
    this.link?.close();
    this.resolveDone(false);
    if (!wasFinishing || message !== "Lost the connection to the voice bridge") this.cb?.onError(message);
  }

  private resolveDone(finalized: boolean): void {
    const w = this.doneWaiter;
    this.doneWaiter = undefined;
    w?.(finalized);
  }

  async finish(): Promise<boolean> {
    if (this.state !== "active") return true;
    this.state = "finishing";
    this.link?.send({ t: "stop" });
    return new Promise<boolean>((resolve) => {
      const timer = setTimeout(() => {
        this.doneWaiter = undefined;
        this.state = "over";
        this.link?.close();
        resolve(false);
      }, this.connector.opts.doneTimeoutMs);
      this.doneWaiter = (finalized) => {
        clearTimeout(timer);
        resolve(finalized);
      };
    });
  }

  async abort(): Promise<void> {
    this.state = "over";
    this.link?.close();
    this.resolveDone(false);
  }
}
