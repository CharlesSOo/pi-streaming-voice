/**
 * The Mac side of the voice bridge: one loopback listener per remote account, each accepting only that account's
 * token. After a mutual handshake, `start` opens the microphone and a Deepgram stream; their events go back as
 * JSON lines. One take at a time across all connections.
 */
import { createServer, type Server, type Socket } from "node:net";
import {
  AUTH_TIMEOUT_MS,
  authMac,
  CLIENT_LINE_LIMIT,
  encode,
  LineReader,
  macEquals,
  newNonce,
  parseClientMessage,
  PROTOCOL_VERSION,
  type BridgeMessage,
  type ErrorCode,
} from "./bridge-protocol.ts";
import type { Transcriber } from "./transcriber.ts";

/** Hard cap on one take. */
export const TAKE_LIMIT_MS = 10 * 60 * 1000;
const LEVEL_INTERVAL_MS = 100;

export interface BridgeEndpoint {
  /** Who this listener is for, e.g. `devbox`; only for the log. */
  name: string;
  /** Port on the Mac that this account reaches. */
  port: number;
  /** Address to listen on: 127.0.0.1 (default, behind a Rex forward) or the Mac's Tailscale address. */
  host?: string;
  /** This account's token (64 hex chars). */
  token: string;
}

export interface BridgeOptions {
  endpoints: BridgeEndpoint[];
  /** A fresh transcriber for each take; throws (with a message for the user) if none can be made. */
  createTranscriber(): Transcriber;
  /** Never given tokens or transcripts. */
  log(line: string): void;
  takeLimitMs?: number;
  authTimeoutMs?: number;
}

export interface RunningBridge {
  /** Actual ports, in endpoint order (useful with port 0). */
  ports: number[];
  close(): Promise<void>;
}

class Connection {
  private authed = false;
  private readonly nonce = newNonce();
  private readonly reader: LineReader;
  private authTimer: ReturnType<typeof setTimeout> | undefined;
  private take: ActiveTake | undefined;
  closed = false;

  private readonly socket: Socket;
  private readonly endpoint: BridgeEndpoint;
  private readonly bridge: BridgeState;

  constructor(socket: Socket, endpoint: BridgeEndpoint, bridge: BridgeState) {
    this.socket = socket;
    this.endpoint = endpoint;
    this.bridge = bridge;
    this.reader = new LineReader(CLIENT_LINE_LIMIT, (line) => this.handleLine(line));
    socket.setNoDelay(true);
    socket.on("data", (chunk: Buffer) => {
      if (!this.reader.push(chunk)) this.drop("line too long");
    });
    socket.on("error", () => this.drop());
    socket.on("close", () => this.drop());
    this.authTimer = setTimeout(() => this.drop("no handshake in time"), bridge.authTimeoutMs);
    this.send({ t: "hello", v: PROTOCOL_VERSION, nonce: this.nonce });
  }

  send(msg: BridgeMessage): void {
    if (!this.closed && this.socket.writable) this.socket.write(encode(msg));
  }

  /** Close the connection and release whatever it holds. With a reason before auth, it counts as an auth failure. */
  drop(reason?: string): void {
    if (this.closed) return;
    this.closed = true;
    if (this.authTimer) clearTimeout(this.authTimer);
    this.reader.stop();
    if (reason) {
      this.bridge.log(
        this.authed
          ? `port ${this.endpoint.port} (${this.endpoint.name}): dropped: ${reason}`
          : `port ${this.endpoint.port} (${this.endpoint.name}): auth failure: ${reason}`,
      );
    }
    this.socket.destroy();
    this.bridge.connections.delete(this);
    void this.take?.abort("connection closed");
  }

  private handleLine(line: string): void {
    const msg = parseClientMessage(line);
    if (!msg) {
      this.drop("bad message");
      return;
    }
    if (!this.authed) {
      if (msg.t !== "auth") {
        this.drop("message before auth");
        return;
      }
      const expected = authMac(this.endpoint.token, "client", this.nonce, msg.nonce);
      if (!macEquals(expected, msg.mac)) {
        this.drop("wrong token");
        return;
      }
      this.authed = true;
      if (this.authTimer) clearTimeout(this.authTimer);
      this.authTimer = undefined;
      this.send({ t: "ok", mac: authMac(this.endpoint.token, "bridge", this.nonce, msg.nonce) });
      return;
    }
    switch (msg.t) {
      case "auth":
        this.drop("auth twice");
        return;
      case "start":
        if (this.take) {
          this.drop("start during a take");
          return;
        }
        if (this.bridge.active) {
          this.send({ t: "error", code: "busy", message: "The voice bridge is busy with another take" });
          return;
        }
        this.take = new ActiveTake(this, this.endpoint, this.bridge, () => {
          this.take = undefined;
        });
        void this.take.begin();
        return;
      case "stop":
        if (this.take) void this.take.stop();
        else this.send({ t: "done", finalized: true });
        return;
    }
  }
}

class ActiveTake {
  private transcriber: Transcriber | undefined;
  private started = false;
  private stopRequested = false;
  private over = false;
  private stopping = false;
  private limitTimer: ReturnType<typeof setTimeout> | undefined;
  private levelTimer: ReturnType<typeof setTimeout> | undefined;
  private peak = -1;
  private lastLevelAt = 0;

  private readonly conn: Connection;
  private readonly endpoint: BridgeEndpoint;
  private readonly bridge: BridgeState;
  private readonly onOver: () => void;

  constructor(conn: Connection, endpoint: BridgeEndpoint, bridge: BridgeState, onOver: () => void) {
    this.conn = conn;
    this.endpoint = endpoint;
    this.bridge = bridge;
    this.onOver = onOver;
    bridge.active = this;
  }

  async begin(): Promise<void> {
    this.bridge.log(`port ${this.endpoint.port} (${this.endpoint.name}): take start`);
    this.limitTimer = setTimeout(() => void this.stop(true), this.bridge.takeLimitMs);
    try {
      this.transcriber = this.bridge.createTranscriber();
      await this.transcriber.start({
        onListening: () => this.send({ t: "listening" }),
        onLevel: (level) => this.level(level),
        onInterim: (text) => this.send({ t: "interim", text }),
        onFinal: (text) => this.send({ t: "final", text }),
        onError: (message) => void this.fail(/microphone/i.test(message) ? "mic" : "deepgram", message),
      });
    } catch (error) {
      await this.fail("mic", error instanceof Error ? error.message : String(error));
      return;
    }
    this.started = true;
    if (this.over) {
      await this.transcriber.abort();
      return;
    }
    if (this.stopRequested) await this.stop();
  }

  /** Finish: the last words, then `done`. At the time limit, an `error limit` follows. */
  async stop(limit = false): Promise<void> {
    if (this.over || this.stopping) return;
    if (!this.started) {
      this.stopRequested = true;
      if (!limit) return;
      await this.fail("limit", "Take stopped at the 10 minute limit");
      return;
    }
    this.stopping = true;
    const finalized = (await this.transcriber?.finish()) ?? true;
    if (this.over) return;
    this.flushLevel();
    this.send({ t: "done", finalized });
    if (limit) this.send({ t: "error", code: "limit", message: "Take stopped at the 10 minute limit" });
    this.end("take stop");
  }

  async fail(code: ErrorCode, message: string): Promise<void> {
    if (this.over) return;
    this.send({ t: "error", code, message });
    this.end(`take failed (${code})`);
    await this.transcriber?.abort();
  }

  async abort(reason: string): Promise<void> {
    if (this.over) return;
    this.end(`take aborted: ${reason}`);
    await this.transcriber?.abort();
  }

  private end(what: string): void {
    this.over = true;
    if (this.limitTimer) clearTimeout(this.limitTimer);
    if (this.levelTimer) clearTimeout(this.levelTimer);
    this.limitTimer = this.levelTimer = undefined;
    if (this.bridge.active === this) this.bridge.active = undefined;
    this.bridge.log(`port ${this.endpoint.port} (${this.endpoint.name}): ${what}`);
    this.onOver();
  }

  private send(msg: BridgeMessage): void {
    if (!this.over) this.conn.send(msg);
  }

  /** Levels go out at most every 100 ms, as the peak since the last one. */
  private level(level: number): void {
    if (this.over || this.stopping) return;
    this.peak = Math.max(this.peak, Math.max(0, Math.min(1, level)));
    const wait = this.lastLevelAt + LEVEL_INTERVAL_MS - Date.now();
    if (wait <= 0) this.flushLevel();
    else this.levelTimer ??= setTimeout(() => this.flushLevel(), wait);
  }

  private flushLevel(): void {
    if (this.levelTimer) clearTimeout(this.levelTimer);
    this.levelTimer = undefined;
    if (this.peak < 0) return;
    const v = Math.round(this.peak * 1000) / 1000;
    this.peak = -1;
    this.lastLevelAt = Date.now();
    this.send({ t: "level", v });
  }
}

interface BridgeState {
  active: ActiveTake | undefined;
  connections: Set<Connection>;
  createTranscriber(): Transcriber;
  log(line: string): void;
  takeLimitMs: number;
  authTimeoutMs: number;
}

/** Starts listening on 127.0.0.1 for every endpoint. */
export async function startBridge(opts: BridgeOptions): Promise<RunningBridge> {
  const state: BridgeState = {
    active: undefined,
    connections: new Set(),
    createTranscriber: opts.createTranscriber,
    log: opts.log,
    takeLimitMs: opts.takeLimitMs ?? TAKE_LIMIT_MS,
    authTimeoutMs: opts.authTimeoutMs ?? AUTH_TIMEOUT_MS,
  };
  const servers: Server[] = [];
  const ports: number[] = [];
  const closeAll = async () => {
    closed = true;
    for (const t of retries) clearTimeout(t);
    for (const c of [...state.connections]) c.drop();
    await Promise.all(servers.map((s) => new Promise<void>((r) => (s.listening ? s.close(() => r()) : r()))));
  };
  const listen = (server: Server, endpoint: BridgeEndpoint) =>
    new Promise<void>((resolve, reject) => {
      server.once("error", reject);
      server.listen(endpoint.port, endpoint.host ?? "127.0.0.1", () => {
        server.off("error", reject);
        const address = server.address();
        if (typeof address === "object" && address) endpoint.port = address.port;
        resolve();
      });
    });
  let closed = false;
  const retries: Array<ReturnType<typeof setTimeout>> = [];
  try {
    for (const given of opts.endpoints) {
      const endpoint = { ...given };
      const server = createServer((socket) => {
        const conn = new Connection(socket, endpoint, state);
        if (!conn.closed) state.connections.add(conn);
      });
      servers.push(server);
      if (!endpoint.host || endpoint.host === "127.0.0.1") {
        // Loopback: the Rex forward is the only way in from the remote host.
        await listen(server, endpoint);
      } else {
        // A Tailscale address may not be up yet (just after login): keep trying without holding up the others.
        const attempt = (first: boolean): void => {
          if (closed) return;
          listen(server, endpoint).then(
            () => opts.log(`listening on ${endpoint.host}:${endpoint.port} (${endpoint.name})`),
            (error: unknown) => {
              if (first) opts.log(`cannot listen on ${endpoint.host}:${endpoint.port} (${endpoint.name}) yet: ${error instanceof Error ? error.message : String(error)}; retrying every 30 s`);
              retries.push(setTimeout(() => attempt(false), 30_000));
            },
          );
        };
        attempt(true);
      }
      ports.push(endpoint.port);
    }
  } catch (error) {
    await closeAll();
    throw error;
  }
  return { ports, close: closeAll };
}
