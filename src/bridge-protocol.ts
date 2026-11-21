/**
 * The voice bridge wire protocol: JSON lines over a loopback TCP socket that Rex forwards from a remote host to
 * the Mac. Only text and levels cross it; audio and the Deepgram key stay on the Mac.
 *
 * Handshake (mutual, the token never on the wire):
 *   bridge → client  {"t":"hello","v":1,"nonce":<32 random bytes, hex>}
 *   client → bridge  {"t":"auth","nonce":<32 random bytes, hex>,"mac":HMAC(token, "client\n" + bridgeNonce + "\n" + clientNonce)}
 *   bridge → client  {"t":"ok","mac":HMAC(token, "bridge\n" + bridgeNonce + "\n" + clientNonce)}
 * Either side closes the socket on a wrong MAC, anything off-schema, a line over the limit, or no handshake within
 * AUTH_TIMEOUT_MS.
 *
 * After it:
 *   client → bridge  {"t":"start"} | {"t":"stop"}
 *   bridge → client  {"t":"listening"} | {"t":"level","v":0..1} | {"t":"interim","text"} | {"t":"final","text"}
 *                    | {"t":"error","code","message"} | {"t":"done","finalized":bool}
 */
import { createHmac, randomBytes, timingSafeEqual } from "node:crypto";

export const PROTOCOL_VERSION = 1;
/** Generous: a new connection through a Rex tunnel (220 ms RTT) takes over a second before `hello` arrives. */
export const AUTH_TIMEOUT_MS = 8_000;
/** Longest line the bridge accepts from a client. */
export const CLIENT_LINE_LIMIT = 4 * 1024;
/** Longest line a client accepts from the bridge (transcripts can be long). */
export const BRIDGE_LINE_LIMIT = 256 * 1024;
export const TOKEN_BYTES = 32;
const HEX64 = /^[0-9a-f]{64}$/;

export const ERROR_CODES = ["busy", "mic", "deepgram", "limit", "internal"] as const;
export type ErrorCode = (typeof ERROR_CODES)[number];

export type ClientMessage =
  | { t: "auth"; nonce: string; mac: string }
  | { t: "start" }
  | { t: "stop" };

export type BridgeMessage =
  | { t: "hello"; v: number; nonce: string }
  | { t: "ok"; mac: string }
  | { t: "listening" }
  | { t: "level"; v: number }
  | { t: "interim"; text: string }
  | { t: "final"; text: string }
  | { t: "error"; code: ErrorCode; message: string }
  | { t: "done"; finalized: boolean };

export function newNonce(): string {
  return randomBytes(32).toString("hex");
}

export function newToken(): string {
  return randomBytes(TOKEN_BYTES).toString("hex");
}

/** A token as stored: 64 hex chars. */
export function isToken(value: string): boolean {
  return HEX64.test(value);
}

export function authMac(token: string, role: "client" | "bridge", bridgeNonce: string, clientNonce: string): string {
  return createHmac("sha256", Buffer.from(token, "hex")).update(`${role}\n${bridgeNonce}\n${clientNonce}`).digest("hex");
}

/** Constant-time comparison of two hex MACs. */
export function macEquals(expected: string, given: string): boolean {
  if (!HEX64.test(given)) return false;
  const a = Buffer.from(expected, "hex");
  const b = Buffer.from(given, "hex");
  return a.length === b.length && timingSafeEqual(a, b);
}

function exactKeys(m: Record<string, unknown>, keys: string[]): boolean {
  const own = Object.keys(m);
  return own.length === keys.length && keys.every((k) => Object.hasOwn(m, k));
}

function object(line: string): Record<string, unknown> | undefined {
  let m: unknown;
  try {
    m = JSON.parse(line);
  } catch {
    return undefined;
  }
  return m && typeof m === "object" && !Array.isArray(m) ? (m as Record<string, unknown>) : undefined;
}

/** A client line, or undefined if it is anything but exactly one of the client messages. */
export function parseClientMessage(line: string): ClientMessage | undefined {
  const m = object(line);
  if (!m) return undefined;
  switch (m.t) {
    case "auth":
      return exactKeys(m, ["t", "nonce", "mac"]) && typeof m.nonce === "string" && HEX64.test(m.nonce) && typeof m.mac === "string" && HEX64.test(m.mac)
        ? { t: "auth", nonce: m.nonce, mac: m.mac }
        : undefined;
    case "start":
    case "stop":
      return exactKeys(m, ["t"]) ? { t: m.t } : undefined;
    default:
      return undefined;
  }
}

/** A bridge line, or undefined if it is anything but exactly one of the bridge messages. */
export function parseBridgeMessage(line: string): BridgeMessage | undefined {
  const m = object(line);
  if (!m) return undefined;
  switch (m.t) {
    case "hello":
      return exactKeys(m, ["t", "v", "nonce"]) && m.v === PROTOCOL_VERSION && typeof m.nonce === "string" && HEX64.test(m.nonce)
        ? { t: "hello", v: m.v, nonce: m.nonce }
        : undefined;
    case "ok":
      return exactKeys(m, ["t", "mac"]) && typeof m.mac === "string" && HEX64.test(m.mac) ? { t: "ok", mac: m.mac } : undefined;
    case "listening":
      return exactKeys(m, ["t"]) ? { t: "listening" } : undefined;
    case "level":
      return exactKeys(m, ["t", "v"]) && typeof m.v === "number" && m.v >= 0 && m.v <= 1 ? { t: "level", v: m.v } : undefined;
    case "interim":
    case "final":
      return exactKeys(m, ["t", "text"]) && typeof m.text === "string" ? { t: m.t, text: m.text } : undefined;
    case "error":
      return exactKeys(m, ["t", "code", "message"]) &&
        typeof m.code === "string" &&
        (ERROR_CODES as readonly string[]).includes(m.code) &&
        typeof m.message === "string" &&
        m.message.length <= 1000
        ? { t: "error", code: m.code as ErrorCode, message: m.message }
        : undefined;
    case "done":
      return exactKeys(m, ["t", "finalized"]) && typeof m.finalized === "boolean" ? { t: "done", finalized: m.finalized } : undefined;
    default:
      return undefined;
  }
}

/**
 * Splits a byte stream into lines. Returns false (and stops) once a line would exceed `limit` bytes, so the caller
 * drops the connection.
 */
export class LineReader {
  private buffer = "";
  private dead = false;
  private readonly limit: number;
  private readonly onLine: (line: string) => void;
  constructor(limit: number, onLine: (line: string) => void) {
    this.limit = limit;
    this.onLine = onLine;
  }

  push(chunk: Buffer | string): boolean {
    if (this.dead) return false;
    this.buffer += typeof chunk === "string" ? chunk : chunk.toString("utf8");
    for (;;) {
      const nl = this.buffer.indexOf("\n");
      if (nl < 0) break;
      const line = this.buffer.slice(0, nl);
      this.buffer = this.buffer.slice(nl + 1);
      if (Buffer.byteLength(line) > this.limit) return this.kill();
      this.onLine(line);
      if (this.dead) return false;
    }
    if (Buffer.byteLength(this.buffer) > this.limit) return this.kill();
    return true;
  }

  /** Ignore everything from now on. */
  stop(): void {
    this.dead = true;
    this.buffer = "";
  }

  private kill(): false {
    this.stop();
    return false;
  }
}

export function encode(msg: BridgeMessage | ClientMessage): string {
  return `${JSON.stringify(msg)}\n`;
}
