import { test } from "node:test";
import assert from "node:assert/strict";
import {
  buildListenUrl,
  DeepgramStream,
  describeClose,
  floatToLinear16,
  parseDeepgramMessage,
  type SocketLike,
  type StreamTiming,
} from "../src/deepgram.ts";

const results = (transcript: string, extra: Record<string, unknown> = {}) =>
  JSON.stringify({ type: "Results", channel: { alternatives: [{ transcript, confidence: 0.9 }] }, ...extra });

test("listen URL has the required parameters", () => {
  const url = new URL(buildListenUrl());
  assert.equal(url.origin + url.pathname, "wss://api.deepgram.com/v1/listen");
  for (const [k, v] of Object.entries({
    model: "nova-3",
    language: "en",
    punctuate: "true",
    smart_format: "true",
    interim_results: "true",
    encoding: "linear16",
    sample_rate: "16000",
    channels: "1",
  })) {
    assert.equal(url.searchParams.get(k), v, k);
  }
});

test("listen URL uses the host of the chosen region", () => {
  for (const [region, host] of [
    ["global", "api.deepgram.com"],
    ["eu", "api.eu.deepgram.com"],
    ["au", "api.au.deepgram.com"],
    ["in", "api.in.deepgram.com"],
  ] as const) {
    const url = new URL(buildListenUrl(region));
    assert.equal(url.protocol + "//" + url.host + url.pathname, `wss://${host}/v1/listen`, region);
    assert.equal(url.search, new URL(buildListenUrl()).search, "same parameters on every host");
  }
});

test("parse: interim vs final", () => {
  assert.deepEqual(parseDeepgramMessage(results("hello wor", { is_final: false, start: 1, duration: 0.5 })), {
    kind: "interim",
    text: "hello wor",
    end: 1.5,
  });
  assert.deepEqual(parseDeepgramMessage(results("Hello world.", { is_final: true, speech_final: true, start: 1, duration: 2 })), {
    kind: "final",
    text: "Hello world.",
    end: 3,
    fromFinalize: false,
  });
  assert.deepEqual(parseDeepgramMessage(results("", { is_final: true, from_finalize: true })), {
    kind: "final",
    text: "",
    end: 0,
    fromFinalize: true,
  });
});

test("parse: error frames", () => {
  const e = parseDeepgramMessage(JSON.stringify({ type: "Error", description: "Invalid audio", message: "bad", variant: "DATA-0000" }));
  assert.equal(e.kind, "error");
  assert.match((e as { message: string }).message, /Invalid audio/);
  const legacy = parseDeepgramMessage(JSON.stringify({ err_code: "INVALID_AUTH", err_msg: "Invalid credentials." }));
  assert.equal(legacy.kind, "error");
  assert.match((legacy as { message: string }).message, /Invalid credentials/);
});

test("parse: ignores metadata, speech events, garbage", () => {
  for (const raw of [
    JSON.stringify({ type: "Metadata", request_id: "x" }),
    JSON.stringify({ type: "SpeechStarted" }),
    JSON.stringify({ type: "UtteranceEnd" }),
    "not json",
    "null",
  ]) {
    assert.deepEqual(parseDeepgramMessage(raw), { kind: "ignore" });
  }
});

test("describeClose", () => {
  assert.equal(describeClose(1000, ""), undefined);
  assert.match(describeClose(1006, "") ?? "", /Lost connection/);
  assert.match(describeClose(1008, "DATA-0000") ?? "", /DATA-0000/);
  // Never opened: a rejected key and a dead network look the same, so point at both.
  assert.match(describeClose(1006, "", false) ?? "", /Could not connect to Deepgram: check DEEPGRAM_API_KEY/);
  assert.equal(describeClose(1000, "", false), undefined);
});

test("floatToLinear16 clamps and encodes little-endian", () => {
  const out = floatToLinear16(new Float32Array([0, 1, -1, 2, -0.5]));
  const view = new DataView(out.buffer);
  assert.deepEqual([0, 1, 2, 3, 4].map((i) => view.getInt16(i * 2, true)), [0, 32767, -32768, 32767, -16384]);
});


// ---- stream with a fake socket ----

class FakeSocket implements SocketLike {
  readyState = 0;
  binaryType = "blob";
  sent: Array<string | Uint8Array> = [];
  closedWith: number | undefined;
  onopen: ((ev: unknown) => void) | null = null;
  onmessage: ((ev: { data: unknown }) => void) | null = null;
  onerror: ((ev: unknown) => void) | null = null;
  onclose: ((ev: { code: number; reason: string }) => void) | null = null;
  send(data: string | Uint8Array): void {
    this.sent.push(data);
    if (typeof data === "string") this.onSendJson?.(JSON.parse(data) as { type: string });
  }
  close(code?: number): void {
    if (this.readyState === 3) return;
    this.closedWith = code;
    this.serverClose(code ?? 1000, "");
  }
  onSendJson?: (msg: { type: string }) => void;
  open(): void {
    this.readyState = 1;
    this.onopen?.({});
  }
  message(raw: string): void {
    this.onmessage?.({ data: raw });
  }
  serverClose(code: number, reason: string): void {
    this.readyState = 3;
    this.onclose?.({ code, reason });
  }
  json(): string[] {
    return this.sent.filter((s): s is string => typeof s === "string").map((s) => (JSON.parse(s) as { type: string }).type);
  }
}

const fastTiming: StreamTiming = {
  setTimer: (fn, ms) => setTimeout(fn, Math.min(ms, 20)),
  clearTimer: (h) => clearTimeout(h as ReturnType<typeof setTimeout>),
  setInterval: () => 0,
  clearInterval: () => {},
};

function makeStream() {
  const socket = new FakeSocket();
  const events: string[] = [];
  let seenKey = "";
  const stream = new DeepgramStream(
    "secret-key",
    {
      onInterim: (t) => events.push(`interim:${t}`),
      onFinal: (t) => events.push(`final:${t}`),
      onError: (m) => events.push(`error:${m}`),
    },
    (_url, key) => {
      seenKey = key;
      return socket;
    },
    fastTiming,
  );
  return { socket, events, stream, seenKey: () => seenKey };
}

test("stream: buffers audio until open, then sends it", () => {
  const { socket, stream, seenKey } = makeStream();
  assert.equal(seenKey(), "secret-key");
  stream.sendAudio(new Float32Array(10));
  assert.equal(socket.sent.length, 0);
  socket.open();
  assert.equal(socket.sent.length, 1);
  assert.equal((socket.sent[0] as Uint8Array).byteLength, 20);
  stream.sendAudio(new Float32Array(4));
  assert.equal(socket.sent.length, 2);
});

test("stream: interim then final events", () => {
  const { socket, events } = makeStream();
  socket.open();
  socket.message(results("hel", { is_final: false }));
  socket.message(results("hello there", { is_final: false }));
  socket.message(results("Hello there.", { is_final: true }));
  assert.deepEqual(events, ["interim:hel", "interim:hello there", "final:Hello there."]);
});

test("stream: an empty final for the silence before the words does not blank the interim", () => {
  const { socket, events } = makeStream();
  socket.open();
  socket.message(results("The quick brown", { is_final: false, start: 0, duration: 2.5 }));
  socket.message(results("", { is_final: true, start: 0, duration: 1.2 })); // covers only the silent lead-in
  socket.message(results("The quick brown fox jumps over", { is_final: false, start: 1.2, duration: 2.6 }));
  assert.deepEqual(events, ["interim:The quick brown", "interim:The quick brown fox jumps over"]);
  // An empty final that covers the whole interim does retract it.
  socket.message(results("", { is_final: true, start: 1.2, duration: 2.6 }));
  assert.equal(events.at(-1), "interim:");
});

test("stream: finish sends Finalize, waits for from_finalize, then CloseStream", async () => {
  const { socket, events, stream } = makeStream();
  socket.open();
  socket.onSendJson = (msg) => {
    if (msg.type === "Finalize") {
      setTimeout(() => socket.message(results("last words", { is_final: true, from_finalize: true })), 1);
    }
    if (msg.type === "CloseStream") setTimeout(() => socket.serverClose(1000, ""), 1);
  };
  assert.equal(await stream.finish(), true);
  assert.deepEqual(socket.json(), ["Finalize", "CloseStream"]);
  assert.ok(events.includes("final:last words"));
  assert.ok(!events.some((e) => e.startsWith("error")));
});

test("stream: finish resolves on the finalized result without waiting for the server to close", async () => {
  const { socket, events, stream } = makeStream();
  socket.open();
  socket.onSendJson = (msg) => {
    if (msg.type === "Finalize") setTimeout(() => socket.message(results("done", { is_final: true, from_finalize: true })), 1);
  };
  assert.equal(await stream.finish(), true);
  assert.equal(socket.readyState, 1, "still open: the close happens in the background");
  assert.deepEqual(socket.json(), ["Finalize", "CloseStream"]);
  socket.message(results("too late", { is_final: true })); // nothing may reach the editor any more
  assert.deepEqual(events, ["final:done"]);
  await new Promise((r) => setTimeout(r, 40));
  assert.equal(socket.closedWith, 1000, "closed by us when the server does not");
});

test("stream: finish times out if Deepgram never answers", async () => {
  const { socket, stream } = makeStream();
  socket.open();
  assert.equal(await stream.finish(), false, "tells the caller the last words may be missing");
  assert.deepEqual(socket.json(), ["Finalize", "CloseStream"]);
  await new Promise((r) => setTimeout(r, 40));
  assert.equal(socket.closedWith, 1000);
});

test("stream: error frame reports once and closes", () => {
  const { socket, events } = makeStream();
  socket.open();
  socket.message(results("kept", { is_final: true }));
  socket.message(JSON.stringify({ type: "Error", description: "boom" }));
  assert.deepEqual(events.filter((e) => e.startsWith("error")).length, 1);
  assert.ok(events.includes("final:kept"));
  assert.equal(socket.readyState, 3);
});

test("stream: network drop reports an error", () => {
  const { socket, events } = makeStream();
  socket.open();
  socket.serverClose(1006, "");
  assert.deepEqual(events, ["error:Lost connection to Deepgram"]);
});

test("stream: auth failure before open names the key; finish still resolves", async () => {
  const { socket, events, stream } = makeStream();
  socket.serverClose(1006, "");
  assert.equal(await stream.finish(), true);
  assert.deepEqual(events, ["error:Could not connect to Deepgram: check DEEPGRAM_API_KEY and your network"]);
});

test("stream: finish before open waits for the connection, then flushes", async () => {
  const { socket, stream } = makeStream();
  stream.sendAudio(new Float32Array(8));
  setTimeout(() => socket.open(), 1);
  await stream.finish();
  assert.ok(socket.sent[0] instanceof Uint8Array);
  assert.deepEqual(socket.json(), ["Finalize", "CloseStream"]);
});
