/** Deepgram live (streaming) transcription over WebSocket. */

export const SAMPLE_RATE = 16_000;
export const DEEPGRAM_LISTEN_URL = "wss://api.deepgram.com/v1/listen";
const KEEPALIVE_MS = 5_000;
const FINALIZE_TIMEOUT_MS = 3_000;
const CLOSE_TIMEOUT_MS = 2_000;

export function buildListenUrl(base = DEEPGRAM_LISTEN_URL): string {
  const params = new URLSearchParams({
    model: "nova-3",
    language: "en",
    punctuate: "true",
    smart_format: "true",
    interim_results: "true",
    encoding: "linear16",
    sample_rate: String(SAMPLE_RATE),
    channels: "1",
  });
  return `${base}?${params.toString()}`;
}

export type DeepgramEvent =
  | { kind: "interim"; text: string }
  | { kind: "final"; text: string; fromFinalize: boolean }
  | { kind: "error"; message: string }
  | { kind: "ignore" };

/** Interpret one text frame from Deepgram. */
export function parseDeepgramMessage(raw: string): DeepgramEvent {
  let msg: unknown;
  try {
    msg = JSON.parse(raw);
  } catch {
    return { kind: "ignore" };
  }
  if (!msg || typeof msg !== "object") return { kind: "ignore" };
  const m = msg as Record<string, unknown>;
  const type = m.type;
  if (type === "Error" || (type === undefined && ("err_code" in m || "err_msg" in m))) {
    const parts = [m.description, m.message, m.err_msg, m.variant ?? m.err_code].filter(
      (p): p is string => typeof p === "string" && p.length > 0,
    );
    return { kind: "error", message: parts.length ? [...new Set(parts)].join(" — ") : "Deepgram reported an error" };
  }
  if (type !== "Results") return { kind: "ignore" };
  const channel = m.channel as { alternatives?: Array<{ transcript?: unknown }> } | undefined;
  const transcript = channel?.alternatives?.[0]?.transcript;
  const text = typeof transcript === "string" ? transcript.trim() : "";
  if (m.is_final === true) return { kind: "final", text, fromFinalize: m.from_finalize === true };
  return { kind: "interim", text };
}

/** Explain a WebSocket close the user should hear about, or undefined for a normal close. */
export function describeClose(code: number, reason: string): string | undefined {
  if (code === 1000) return undefined;
  if (code === 1008 || code === 1011 || code === 4000 || reason) {
    return `Deepgram closed the connection (${code}${reason ? `: ${reason}` : ""})`;
  }
  if (code === 1006) return "Lost connection to Deepgram";
  return `Deepgram connection closed unexpectedly (${code})`;
}

/** Float32 [-1, 1] → little-endian signed 16-bit PCM. */
export function floatToLinear16(samples: Float32Array): Uint8Array {
  const out = new Uint8Array(samples.length * 2);
  const view = new DataView(out.buffer);
  for (let i = 0; i < samples.length; i += 1) {
    const s = Math.max(-1, Math.min(1, samples[i] ?? 0));
    view.setInt16(i * 2, s < 0 ? Math.round(s * 0x8000) : Math.round(s * 0x7fff), true);
  }
  return out;
}

/** Minimal WebSocket surface (Node's global WebSocket satisfies it). */
export interface SocketLike {
  readonly readyState: number;
  binaryType: string;
  send(data: string | Uint8Array): void;
  close(code?: number, reason?: string): void;
  onopen: ((ev: unknown) => void) | null;
  onmessage: ((ev: { data: unknown }) => void) | null;
  onerror: ((ev: unknown) => void) | null;
  onclose: ((ev: { code: number; reason: string }) => void) | null;
}

export type SocketFactory = (url: string, apiKey: string) => SocketLike;

export const defaultSocketFactory: SocketFactory = (url, apiKey) => {
  // Node's WebSocket (undici) accepts headers; the key never leaves this header.
  const Ctor = globalThis.WebSocket as unknown as new (u: string, init: unknown) => SocketLike;
  return new Ctor(url, { headers: { Authorization: `Token ${apiKey}` } });
};

const OPEN = 1;

export interface StreamCallbacks {
  onInterim(text: string): void;
  onFinal(text: string): void;
  /** Fatal stream error (once). Already-delivered finals stay valid. */
  onError(message: string): void;
}

export interface StreamTiming {
  setTimer(fn: () => void, ms: number): unknown;
  clearTimer(handle: unknown): void;
  setInterval(fn: () => void, ms: number): unknown;
  clearInterval(handle: unknown): void;
}

const realTiming: StreamTiming = {
  setTimer: (fn, ms) => setTimeout(fn, ms),
  clearTimer: (h) => clearTimeout(h as ReturnType<typeof setTimeout>),
  setInterval: (fn, ms) => setInterval(fn, ms),
  clearInterval: (h) => clearInterval(h as ReturnType<typeof setInterval>),
};

/**
 * One live transcription session. Audio sent before the socket opens is
 * buffered. `finish()` flushes (Finalize), waits for the final results, then
 * sends CloseStream and waits for the server to close.
 */
export class DeepgramStream {
  private readonly socket: SocketLike;
  private pending: Uint8Array[] = [];
  private keepAlive: unknown;
  private failed = false;
  private closed = false;
  private finishing = false;
  private finalizeWaiter: (() => void) | undefined;
  private closeWaiter: (() => void) | undefined;
  private openWaiter: (() => void) | undefined;

  private readonly cb: StreamCallbacks;
  private readonly timing: StreamTiming;

  constructor(
    apiKey: string,
    cb: StreamCallbacks,
    factory: SocketFactory = defaultSocketFactory,
    timing: StreamTiming = realTiming,
    url = buildListenUrl(),
  ) {
    this.cb = cb;
    this.timing = timing;
    this.socket = factory(url, apiKey);
    this.socket.binaryType = "arraybuffer";
    this.socket.onopen = () => {
      for (const chunk of this.pending) this.socket.send(chunk);
      this.pending = [];
      this.keepAlive = this.timing.setInterval(() => this.sendJson({ type: "KeepAlive" }), KEEPALIVE_MS);
      const w = this.openWaiter;
      this.openWaiter = undefined;
      w?.();
    };
    this.socket.onmessage = (ev) => {
      if (typeof ev.data !== "string") return;
      this.handleMessage(ev.data);
    };
    this.socket.onerror = () => {
      // The close event follows with the code; report there.
    };
    this.socket.onclose = (ev) => this.handleClose(ev.code, ev.reason);
  }

  /** Test hook / internal: process one server text frame. */
  handleMessage(raw: string): void {
    const event = parseDeepgramMessage(raw);
    switch (event.kind) {
      case "interim":
        this.cb.onInterim(event.text);
        break;
      case "final":
        if (event.text) this.cb.onFinal(event.text);
        this.cb.onInterim("");
        if (event.fromFinalize) this.resolveFinalize();
        break;
      case "error":
        this.fail(event.message);
        this.socket.close(1000);
        break;
      case "ignore":
        break;
    }
  }

  sendAudio(samples: Float32Array): void {
    if (this.failed || this.closed || this.finishing) return;
    const pcm = floatToLinear16(samples);
    if (this.socket.readyState === OPEN) this.socket.send(pcm);
    else this.pending.push(pcm);
  }

  /** Flush and wait for final results, then close. Never throws. */
  async finish(): Promise<void> {
    if (this.finishing) return;
    this.finishing = true;
    if (this.failed || this.closed) return this.cleanup();
    if (this.socket.readyState !== OPEN) {
      // Never connected: wait briefly for the open so buffered audio still gets transcribed.
      await this.waitFor((resolve) => {
        this.openWaiter = resolve;
      }, FINALIZE_TIMEOUT_MS);
      this.openWaiter = undefined;
      if (this.socket.readyState !== OPEN) {
        this.socket.close(1000);
        return this.cleanup();
      }
    }
    this.sendJson({ type: "Finalize" });
    await this.waitFor((resolve) => {
      this.finalizeWaiter = resolve;
    }, FINALIZE_TIMEOUT_MS);
    this.sendJson({ type: "CloseStream" });
    if (!this.closed) {
      await this.waitFor((resolve) => {
        this.closeWaiter = resolve;
      }, CLOSE_TIMEOUT_MS);
    }
    if (!this.closed) this.socket.close(1000);
    this.cleanup();
  }

  /** Drop everything immediately. */
  abort(): void {
    this.finishing = true;
    try {
      this.socket.close(1000);
    } catch {
      // already closed
    }
    this.cleanup();
  }

  private handleClose(code: number, reason: string): void {
    this.closed = true;
    const problem = describeClose(code, reason);
    // Closing after CloseStream is expected; anything abnormal before that is an error.
    if (problem && !this.failed) this.fail(problem);
    this.resolveFinalize();
    const waiters = [this.closeWaiter, this.openWaiter];
    this.closeWaiter = undefined;
    this.openWaiter = undefined;
    for (const w of waiters) w?.();
    this.cleanup();
  }

  private fail(message: string): void {
    if (this.failed) return;
    this.failed = true;
    this.cb.onError(message);
    this.resolveFinalize();
  }

  private resolveFinalize(): void {
    const w = this.finalizeWaiter;
    this.finalizeWaiter = undefined;
    w?.();
  }

  private sendJson(msg: object): void {
    if (this.socket.readyState === OPEN) this.socket.send(JSON.stringify(msg));
  }

  private waitFor(arm: (resolve: () => void) => void, ms: number): Promise<void> {
    return new Promise<void>((resolve) => {
      let done = false;
      const finish = () => {
        if (done) return;
        done = true;
        this.timing.clearTimer(timer);
        resolve();
      };
      const timer = this.timing.setTimer(finish, ms);
      arm(finish);
      if (this.failed || this.closed) finish();
    });
  }

  private cleanup(): void {
    if (this.keepAlive !== undefined) this.timing.clearInterval(this.keepAlive);
    this.keepAlive = undefined;
    this.pending = [];
  }
}
