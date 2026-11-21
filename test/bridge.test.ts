// The voice bridge: protocol, Mac-side server and remote-side BridgeTranscriber, over real loopback sockets.
import assert from "node:assert/strict";
import { chmodSync, mkdtempSync, writeFileSync } from "node:fs";
import { createServer, connect, type Socket } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { BridgeConnector, BridgeTranscriber, loadBridgeConfig, type BridgeClientConfig, type BridgeClientOptions } from "../src/bridge-client.ts";
import {
  authMac,
  CLIENT_LINE_LIMIT,
  LineReader,
  newNonce,
  newToken,
  parseBridgeMessage,
  parseClientMessage,
} from "../src/bridge-protocol.ts";
import { startBridge, type RunningBridge } from "../src/bridge-server.ts";
import type { Transcriber, TranscriberCallbacks } from "../src/transcriber.ts";

const sleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));

const connectors: BridgeConnector[] = [];
/** A transcriber on its own connector (disposed after each test file run). */
function bt(config: BridgeClientConfig, opts: BridgeClientOptions = {}): BridgeTranscriber {
  const c = new BridgeConnector(() => config, opts);
  connectors.push(c);
  return new BridgeTranscriber(c);
}
test.afterEach(() => {
  for (const c of connectors.splice(0)) c.dispose();
});

class FakeTranscriber implements Transcriber {
  static all: FakeTranscriber[] = [];
  cb: TranscriberCallbacks | undefined;
  finished = false;
  aborted = false;
  constructor() {
    FakeTranscriber.all.push(this);
  }
  async start(cb: TranscriberCallbacks): Promise<void> {
    this.cb = cb;
    setImmediate(() => {
      cb.onListening();
      cb.onLevel(0.5);
      cb.onInterim("hello");
    });
  }
  async finish(): Promise<boolean> {
    this.finished = true;
    this.cb?.onFinal("Hello world.");
    return true;
  }
  async abort(): Promise<void> {
    this.aborted = true;
  }
}

interface Rig {
  bridge: RunningBridge;
  tokenA: string;
  tokenB: string;
  portA: number;
  portB: number;
  logs: string[];
}

async function rig(opts: { takeLimitMs?: number; authTimeoutMs?: number } = {}): Promise<Rig> {
  FakeTranscriber.all = [];
  const tokenA = newToken();
  const tokenB = newToken();
  const logs: string[] = [];
  const bridge = await startBridge({
    endpoints: [
      { name: "a", port: 0, token: tokenA },
      { name: "b", port: 0, token: tokenB },
    ],
    createTranscriber: () => new FakeTranscriber(),
    log: (l) => logs.push(l),
    authTimeoutMs: opts.authTimeoutMs ?? 300,
    ...(opts.takeLimitMs !== undefined && { takeLimitMs: opts.takeLimitMs }),
  });
  return { bridge, tokenA, tokenB, portA: bridge.ports[0]!, portB: bridge.ports[1]!, logs };
}

/** A raw protocol client: lines in, lines out. */
async function raw(port: number): Promise<{ socket: Socket; lines: string[]; closed: Promise<void>; next(): Promise<string> }> {
  const socket = connect({ host: "127.0.0.1", port });
  const lines: string[] = [];
  let buf = "";
  socket.on("data", (d: Buffer) => {
    buf += d.toString();
    let nl;
    while ((nl = buf.indexOf("\n")) >= 0) {
      lines.push(buf.slice(0, nl));
      buf = buf.slice(nl + 1);
    }
  });
  socket.on("error", () => undefined);
  const closed = new Promise<void>((r) => socket.on("close", () => r()));
  await new Promise<void>((r) => socket.once("connect", () => r()));
  let read = 0;
  return {
    socket,
    lines,
    closed,
    async next() {
      for (let i = 0; i < 200 && lines.length <= read; i += 1) await sleep(5);
      return lines[read++] ?? "";
    },
  };
}

async function authed(port: number, token: string) {
  const c = await raw(port);
  const hello = parseBridgeMessage(await c.next());
  assert.equal(hello?.t, "hello");
  const nonce = newNonce();
  const bridgeNonce = (hello as { nonce: string }).nonce;
  c.socket.write(`${JSON.stringify({ t: "auth", nonce, mac: authMac(token, "client", bridgeNonce, nonce) })}\n`);
  const ok = parseBridgeMessage(await c.next());
  assert.equal(ok?.t, "ok");
  assert.equal((ok as { mac: string }).mac, authMac(token, "bridge", bridgeNonce, nonce), "the bridge proves it has the token");
  return c;
}

function events(): { cb: TranscriberCallbacks; log: string[] } {
  const log: string[] = [];
  return {
    log,
    cb: {
      onListening: () => log.push("listening"),
      onLevel: (v) => log.push(`level:${v}`),
      onInterim: (t) => log.push(`interim:${t}`),
      onFinal: (t) => log.push(`final:${t}`),
      onError: (m) => log.push(`error:${m}`),
    },
  };
}

// ------------------------------------------------------------------ protocol

test("message parsing is strict: exact keys, types, hex sizes", () => {
  const hex = "a".repeat(64);
  assert.deepEqual(parseClientMessage(`{"t":"start"}`), { t: "start" });
  assert.deepEqual(parseClientMessage(JSON.stringify({ t: "auth", nonce: hex, mac: hex })), { t: "auth", nonce: hex, mac: hex });
  for (const bad of [
    "",
    "nope",
    "[]",
    "null",
    `{"t":"start","x":1}`,
    `{"t":"go"}`,
    JSON.stringify({ t: "auth", nonce: hex, mac: "A".repeat(64) }),
    JSON.stringify({ t: "auth", nonce: hex.slice(1), mac: hex }),
    JSON.stringify({ t: "auth", nonce: hex }),
  ]) {
    assert.equal(parseClientMessage(bad), undefined, bad);
  }
  assert.deepEqual(parseBridgeMessage(`{"t":"level","v":0.5}`), { t: "level", v: 0.5 });
  assert.equal(parseBridgeMessage(`{"t":"level","v":2}`), undefined);
  assert.equal(parseBridgeMessage(`{"t":"error","code":"weird","message":"x"}`), undefined);
  assert.equal(parseBridgeMessage(`{"t":"done","finalized":"yes"}`), undefined);
  assert.equal(parseBridgeMessage(`{"t":"hello","v":2,"nonce":"${hex}"}`), undefined, "other protocol version");
});

test("line reader: splits lines, refuses a line over the limit, also one that never ends", () => {
  const got: string[] = [];
  const r = new LineReader(10, (l) => got.push(l));
  assert.equal(r.push("ab\ncd"), true);
  assert.equal(r.push("e\n"), true);
  assert.deepEqual(got, ["ab", "cde"]);
  assert.equal(r.push("x".repeat(11) + "\n"), false);
  assert.equal(r.push("ok\n"), false, "dead after that");
  const r2 = new LineReader(10, () => undefined);
  assert.equal(r2.push("y".repeat(11)), false, "no newline but already too long");
});

test("bridge drops a client line over 4 KB", async () => {
  const r = await rig();
  try {
    const c = await authed(r.portA, r.tokenA);
    c.socket.write(`{"t":"start","pad":"${"x".repeat(CLIENT_LINE_LIMIT)}"}\n`);
    await c.closed;
    assert.equal(FakeTranscriber.all.length, 0);
  } finally {
    await r.bridge.close();
  }
});

test("bridge drops an off-schema message after auth", async () => {
  const r = await rig();
  try {
    const c = await authed(r.portA, r.tokenA);
    c.socket.write(`{"t":"start","now":true}\n`);
    await c.closed;
    assert.equal(FakeTranscriber.all.length, 0);
  } finally {
    await r.bridge.close();
  }
});

// ------------------------------------------------------------------ handshake

test("handshake with the right token, then start → events → done", async () => {
  const r = await rig();
  try {
    const c = await authed(r.portA, r.tokenA);
    c.socket.write(`{"t":"start"}\n`);
    assert.deepEqual(parseBridgeMessage(await c.next()), { t: "listening" });
    assert.deepEqual(parseBridgeMessage(await c.next()), { t: "level", v: 0.5 });
    assert.deepEqual(parseBridgeMessage(await c.next()), { t: "interim", text: "hello" });
    c.socket.write(`{"t":"stop"}\n`);
    assert.deepEqual(parseBridgeMessage(await c.next()), { t: "final", text: "Hello world." });
    assert.deepEqual(parseBridgeMessage(await c.next()), { t: "done", finalized: true });
    assert.equal(FakeTranscriber.all[0]?.finished, true);
    assert.ok(r.logs.some((l) => l.includes("take start")));
    assert.ok(r.logs.every((l) => !l.includes(r.tokenA) && !l.includes("Hello")), "no tokens or transcripts in the log");
    c.socket.destroy();
  } finally {
    await r.bridge.close();
  }
});

test("wrong token is refused, and so is the other host's token on this host's port", async () => {
  const r = await rig();
  try {
    for (const token of [newToken(), r.tokenB]) {
      const c = await raw(r.portA);
      const hello = parseBridgeMessage(await c.next()) as { nonce: string };
      const nonce = newNonce();
      c.socket.write(`${JSON.stringify({ t: "auth", nonce, mac: authMac(token, "client", hello.nonce, nonce) })}\n`);
      await c.closed;
      assert.equal(c.lines.length, 1, "nothing after hello");
    }
    assert.equal(r.logs.filter((l) => l.includes("auth failure") && l.includes(`port ${r.portA}`)).length, 2);
    assert.equal(FakeTranscriber.all.length, 0);
  } finally {
    await r.bridge.close();
  }
});

test("start before auth is refused", async () => {
  const r = await rig();
  try {
    const c = await raw(r.portA);
    await c.next();
    c.socket.write(`{"t":"start"}\n`);
    await c.closed;
    assert.equal(FakeTranscriber.all.length, 0);
  } finally {
    await r.bridge.close();
  }
});

test("no handshake in time: the bridge closes the socket", async () => {
  const r = await rig();
  try {
    const c = await raw(r.portA);
    const t0 = Date.now();
    await c.closed;
    assert.ok(Date.now() - t0 >= 250);
    assert.ok(r.logs.some((l) => l.includes("auth failure: no handshake in time")));
  } finally {
    await r.bridge.close();
  }
});

test("one take at a time across hosts: the second start gets busy", async () => {
  const r = await rig();
  try {
    const a = await authed(r.portA, r.tokenA);
    a.socket.write(`{"t":"start"}\n`);
    await a.next();
    const b = await authed(r.portB, r.tokenB);
    b.socket.write(`{"t":"start"}\n`);
    assert.deepEqual(parseBridgeMessage(await b.next()), { t: "error", code: "busy", message: "The voice bridge is busy with another take" });
    assert.equal(FakeTranscriber.all.length, 1);
    // Closing the first connection releases the take at once.
    a.socket.destroy();
    await sleep(30);
    assert.equal(FakeTranscriber.all[0]?.aborted, true);
    b.socket.write(`{"t":"start"}\n`);
    assert.deepEqual(parseBridgeMessage(await b.next()), { t: "listening" });
    b.socket.destroy();
  } finally {
    await r.bridge.close();
  }
});

test("a take stops at the time limit", async () => {
  const r = await rig({ takeLimitMs: 100 });
  try {
    const c = await authed(r.portA, r.tokenA);
    c.socket.write(`{"t":"start"}\n`);
    const seen: string[] = [];
    for (let i = 0; i < 6; i += 1) seen.push(await c.next());
    assert.ok(seen.includes(JSON.stringify({ t: "done", finalized: true })));
    assert.ok(seen.some((l) => l.includes(`"code":"limit"`)));
    assert.equal(FakeTranscriber.all[0]?.finished, true);
  } finally {
    await r.bridge.close();
  }
});

// ------------------------------------------------------------------ BridgeTranscriber

test("BridgeTranscriber happy path: events, then the last words and done", async () => {
  const r = await rig();
  try {
    const t = bt({ port: r.portA, token: r.tokenA });
    const e = events();
    await t.start(e.cb);
    await sleep(50);
    assert.deepEqual(e.log, ["listening", "level:0.5", "interim:hello"]);
    assert.equal(await t.finish(), true);
    assert.deepEqual(e.log.slice(3), ["final:Hello world."]);
  } finally {
    await r.bridge.close();
  }
});

test("BridgeTranscriber: bridge down is a clear error", async () => {
  const probe = createServer();
  await new Promise<void>((res) => probe.listen(0, "127.0.0.1", () => res()));
  const port = (probe.address() as { port: number }).port;
  await new Promise<void>((res) => probe.close(() => res()));
  const t = bt({ port, token: newToken() });
  await assert.rejects(t.start(events().cb), { message: `Voice bridge not reachable on 127.0.0.1:${port}: is the Mac bridge running?` });
});

test("BridgeTranscriber: a forward that accepts and closes (Mac bridge down behind Rex) reads as not reachable", async () => {
  const server = createServer((s) => s.destroy());
  await new Promise<void>((res) => server.listen(0, "127.0.0.1", () => res()));
  const port = (server.address() as { port: number }).port;
  try {
    const t = bt({ port, token: newToken() });
    await assert.rejects(t.start(events().cb), /not reachable/);
  } finally {
    server.close();
  }
});

test("BridgeTranscriber: wrong token is refused by the bridge", async () => {
  const r = await rig();
  try {
    const t = bt({ port: r.portA, token: r.tokenB });
    await assert.rejects(t.start(events().cb), /refused the connection/);
  } finally {
    await r.bridge.close();
  }
});

test("BridgeTranscriber: a squatter on the port cannot pass as the bridge or feed it text", async () => {
  const seen: string[] = [];
  const squatter = createServer((s) => {
    s.write(`${JSON.stringify({ t: "hello", v: 1, nonce: newNonce() })}\n`);
    s.on("data", (d: Buffer) => {
      seen.push(d.toString());
      // Answers with a made-up proof and some text.
      s.write(`${JSON.stringify({ t: "ok", mac: "0".repeat(64) })}\n{"t":"final","text":"rm -rf"}\n`);
    });
  });
  await new Promise<void>((res) => squatter.listen(0, "127.0.0.1", () => res()));
  const port = (squatter.address() as { port: number }).port;
  try {
    const token = newToken();
    const t = bt({ port, token });
    const e = events();
    await assert.rejects(t.start(e.cb), /failed authentication/);
    assert.deepEqual(e.log, [], "nothing from the squatter is used");
    assert.ok(seen.every((s) => !s.includes(token)), "the token never crosses the wire");
    assert.ok(seen.every((s) => !s.includes("start")), "no start sent");
  } finally {
    squatter.close();
  }
});

test("BridgeTranscriber: a server that never says hello times out", async () => {
  const held: Socket[] = [];
  const silent = createServer((s) => void held.push(s));
  await new Promise<void>((res) => silent.listen(0, "127.0.0.1", () => res()));
  const port = (silent.address() as { port: number }).port;
  try {
    const t = bt({ port, token: newToken() }, { authTimeoutMs: 200 });
    await assert.rejects(t.start(events().cb), /not reachable/);
  } finally {
    for (const s of held) s.destroy();
    silent.close();
  }
});

test("BridgeTranscriber: busy bridge is reported through onError", async () => {
  const r = await rig();
  try {
    const a = bt({ port: r.portA, token: r.tokenA });
    await a.start(events().cb);
    await sleep(30);
    const b = bt({ port: r.portB, token: r.tokenB });
    const e = events();
    await b.start(e.cb);
    await sleep(50);
    assert.deepEqual(e.log, ["error:Voice bridge is busy with a take from another session"]);
    await a.abort();
  } finally {
    await r.bridge.close();
  }
});

test("token file readable by others is refused", () => {
  const dir = mkdtempSync(join(tmpdir(), "psv-bridge-"));
  writeFileSync(join(dir, "pi-streaming-voice-bridge.json"), JSON.stringify({ port: 47821 }));
  const tokenFile = join(dir, "pi-streaming-voice-bridge.token");
  const token = newToken();
  writeFileSync(tokenFile, `${token}\n`);
  chmodSync(tokenFile, 0o644);
  assert.throws(() => loadBridgeConfig(dir), /readable by other users/);
  chmodSync(tokenFile, 0o600);
  assert.deepEqual(loadBridgeConfig(dir), { port: 47821, token });
  writeFileSync(join(dir, "pi-streaming-voice-bridge.json"), JSON.stringify({ host: "100.64.0.1", port: 47812 }));
  assert.deepEqual(loadBridgeConfig(dir), { host: "100.64.0.1", port: 47812, token });
  writeFileSync(join(dir, "pi-streaming-voice-bridge.json"), JSON.stringify({ host: "evil.example", port: 47812 }));
  assert.throws(() => loadBridgeConfig(dir), /must be an IP address/);
});

// ------------------------------------------------------------------ warm connection

/** A TCP proxy that delays every new connection's first bytes, like a fresh connection through a Rex tunnel. */
async function slowProxy(target: number, delayMs: number) {
  const sockets: Socket[] = [];
  const server = createServer((client) => {
    sockets.push(client);
    const upstream = connect({ host: "127.0.0.1", port: target });
    sockets.push(upstream);
    let first = true;
    upstream.on("data", (d: Buffer) => {
      if (first) {
        first = false;
        setTimeout(() => client.write(d), delayMs);
      } else client.write(d);
    });
    client.on("data", (d: Buffer) => upstream.write(d));
    const end = () => {
      client.destroy();
      upstream.destroy();
    };
    client.on("close", end);
    upstream.on("close", end);
    client.on("error", () => undefined);
    upstream.on("error", () => undefined);
  });
  await new Promise<void>((res) => server.listen(0, "127.0.0.1", () => res()));
  return {
    port: (server.address() as { port: number }).port,
    /** Cut every connection (the tunnel dropped). */
    cut: () => sockets.splice(0).forEach((s) => s.destroy()),
    close: () => {
      sockets.splice(0).forEach((s) => s.destroy());
      server.close();
    },
  };
}

test("pre-warm: the handshake happens ahead of the take, so start only sends start", async () => {
  const r = await rig({ authTimeoutMs: 5000 });
  const proxy = await slowProxy(r.portA, 400);
  try {
    const c = new BridgeConnector(() => ({ port: proxy.port, token: r.tokenA }));
    connectors.push(c);
    c.warm();
    await sleep(600);
    assert.equal(c.isWarm, true);
    assert.equal(FakeTranscriber.all.length, 0, "an idle warm connection holds no device");
    const t = new BridgeTranscriber(c);
    const e = events();
    const t0 = Date.now();
    await t.start(e.cb);
    assert.ok(Date.now() - t0 < 50, "no handshake on the hotkey");
    await sleep(50);
    assert.deepEqual(e.log, ["listening", "level:0.5", "interim:hello"]);
    assert.equal(await t.finish(), true);
    await sleep(700);
    assert.equal(c.isWarm, true, "warm again right after the take");
  } finally {
    proxy.close();
    await r.bridge.close();
  }
});

test("slow handshake: a take pressed while the warm link is being set up starts once it is ready", async () => {
  const r = await rig();
  // Slower than the old 2 s limit; the bridge's own unauthenticated limit is 300 ms in this rig, counted from accept,
  // so the delay goes on hello only after the server sent it: use a bridge with a wide limit.
  await r.bridge.close();
  const tokenA = newToken();
  FakeTranscriber.all = [];
  const bridge = await startBridge({ endpoints: [{ name: "a", port: 0, token: tokenA }], createTranscriber: () => new FakeTranscriber(), log: () => undefined });
  const proxy = await slowProxy(bridge.ports[0]!, 2500);
  try {
    const t = bt({ port: proxy.port, token: tokenA });
    const e = events();
    await t.start(e.cb);
    await sleep(50);
    assert.deepEqual(e.log, ["listening", "level:0.5", "interim:hello"]);
    await t.abort();
  } finally {
    proxy.close();
    await bridge.close();
  }
});

test("reconnect after a drop, quietly, and an idle warm link from another pi does not count as busy", async () => {
  const r = await rig();
  const proxy = await slowProxy(r.portA, 0);
  try {
    const c = new BridgeConnector(() => ({ port: proxy.port, token: r.tokenA }), { backoffMs: 50 });
    connectors.push(c);
    c.warm();
    await sleep(100);
    assert.equal(c.isWarm, true);
    proxy.cut();
    await sleep(30);
    assert.equal(c.isWarm, false);
    await sleep(200);
    assert.equal(c.isWarm, true, "reconnected on its own");
    // Another pi (host b) with a warm link idles; this one's take still runs.
    const other = new BridgeConnector(() => ({ port: r.portB, token: r.tokenB }));
    connectors.push(other);
    other.warm();
    await sleep(50);
    assert.equal(other.isWarm, true);
    const t = new BridgeTranscriber(c);
    const e = events();
    await t.start(e.cb);
    await sleep(50);
    assert.deepEqual(e.log.slice(0, 1), ["listening"]);
    await t.abort();
  } finally {
    proxy.close();
    await r.bridge.close();
  }
});

test("bridge down: warming fails quietly with backoff; a take then reports it", async () => {
  const probe = createServer();
  await new Promise<void>((res) => probe.listen(0, "127.0.0.1", () => res()));
  const port = (probe.address() as { port: number }).port;
  await new Promise<void>((res) => probe.close(() => res()));
  let loads = 0;
  const c = new BridgeConnector(() => {
    loads += 1;
    return { port, token: newToken() };
  }, { backoffMs: 40, maxBackoffMs: 80 });
  connectors.push(c);
  c.warm();
  await sleep(300);
  assert.ok(loads >= 3 && loads <= 8, `retried with backoff (${loads} tries)`);
  await assert.rejects(new BridgeTranscriber(c).start(events().cb), /not reachable/);
});
