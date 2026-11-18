/** Auto region: time a TLS connection to each Deepgram host and pick the fastest. */
import { connect } from "node:tls";
import { REGION_HOSTS, type Region } from "./deepgram.ts";

const TRIES = 3;
const TIMEOUT_MS = 3_000;

/** The region Auto uses, with its median connect time; no `ms` when no host answered. */
export interface AutoPick {
  region: Region;
  ms?: number;
  /** When it was measured (epoch ms). A pick without it is stale. */
  at?: number;
}

/** Connect times per region, one entry per try; `undefined` for a try that failed or timed out. */
export type Timings = Partial<Record<Region, Array<number | undefined>>>;

/** Fastest region by median connect time. A host with a failed try is skipped; with none left, Global. */
export function pickRegion(timings: Timings): AutoPick {
  let best: AutoPick = { region: "global" };
  for (const region of Object.keys(REGION_HOSTS) as Region[]) {
    const tries = timings[region] ?? [];
    const times = tries.filter((t): t is number => t !== undefined).sort((a, b) => a - b);
    if (times.length === 0 || times.length < tries.length) continue;
    const mid = times.length >> 1;
    const ms = Math.round(times.length % 2 ? times[mid]! : (times[mid - 1]! + times[mid]!) / 2);
    if (best.ms === undefined || ms < best.ms) best = { region, ms };
  }
  return best;
}

/**
 * Milliseconds to open a TCP+TLS connection to `host`, which is then dropped: no request, no key.
 * Aborting `signal` destroys the socket (and with it its timeout) and resolves `undefined`.
 */
export function timeConnect(host: string, signal?: AbortSignal, port = 443): Promise<number | undefined> {
  return new Promise((resolve) => {
    if (signal?.aborted) {
      resolve(undefined);
      return;
    }
    const started = performance.now();
    const socket = connect({ host, port, servername: host, timeout: TIMEOUT_MS });
    const abort = () => done(undefined);
    const done = (ms: number | undefined) => {
      signal?.removeEventListener("abort", abort);
      socket.destroy();
      resolve(ms);
    };
    socket.once("secureConnect", () => done(performance.now() - started));
    socket.once("timeout", () => done(undefined));
    socket.once("error", () => done(undefined));
    // A connection that is still opening keeps the process alive (unref does not help), so shutdown aborts it.
    signal?.addEventListener("abort", abort, { once: true });
  });
}

export type MeasureRegions = (signal?: AbortSignal) => Promise<Timings>;

/** Times every host, all at once, a few tries each one after the other. Never rejects. Aborting ends it early. */
export const measureRegions: MeasureRegions = async (signal) => {
  const timings: Timings = {};
  await Promise.all(
    (Object.keys(REGION_HOSTS) as Region[]).map(async (region) => {
      const tries: Array<number | undefined> = [];
      for (let i = 0; i < TRIES; i += 1) {
        const ms = await timeConnect(REGION_HOSTS[region], signal);
        tries.push(ms);
        if (ms === undefined) break;
      }
      timings[region] = tries;
    }),
  );
  return timings;
};
