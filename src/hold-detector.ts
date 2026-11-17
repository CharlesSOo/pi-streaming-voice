/**
 * Space push-to-talk detection.
 *
 * Two paths:
 *  - Kitty: the terminal reports real press/repeat/release events (pi-tui
 *    requests flags 7). The press types a space; if the key is still down after
 *    `kittyHoldMs`, it is a hold: the typed space is removed and recording
 *    starts. The release event stops recording.
 *  - Repeat timing (no release events): the terminal only sends auto-repeated
 *    spaces. A run of `repeatCount` consecutive gaps of at most `repeatGapMs`
 *    is a hold; the spaces typed so far are removed. Recording stops once no
 *    space arrives for the release gap.
 *
 * The kitty path is used only once a key release event has actually been seen,
 * because a terminal can answer the kitty query without supporting event types.
 */

export interface HoldThresholds {
  /** Kitty: key held this long without release = hold. */
  kittyHoldMs: number;
  /** Repeat path: max gap between auto-repeated spaces. */
  repeatGapMs: number;
  /** Repeat path: consecutive rapid gaps needed to call it a hold. */
  repeatCount: number;
  /** Repeat path: max gap between the physical press and its first repeat (the OS initial repeat delay). */
  initialDelayMaxMs: number;
  /** Repeat path: minimum silence after the last repeat that counts as release. */
  releaseGapMinMs: number;
  /** Repeat path: release gap is at least this multiple of the observed repeat interval. */
  releaseGapFactor: number;
}

export const DEFAULT_THRESHOLDS: HoldThresholds = {
  kittyHoldMs: 350,
  repeatGapMs: 125,
  repeatCount: 2,
  initialDelayMaxMs: 650,
  releaseGapMinMs: 200,
  releaseGapFactor: 2.5,
};

export interface HoldDetectorDeps {
  now(): number;
  setTimer(fn: () => void, ms: number): unknown;
  clearTimer(handle: unknown): void;
  /** Whether pi-tui negotiated the kitty keyboard protocol. */
  kittyActive(): boolean;
  /** Hold detected. */
  onStart(): void;
  /** Hold released. */
  onStop(): void;
  /** Remove `count` spaces already typed into the editor (before the cursor). */
  deleteSpaces(count: number): void;
}

export type InputResult = { consume?: boolean; data?: string } | undefined;

export const BACKSPACE = "\x7f";

type SpaceEvent = "press" | "repeat" | "release";

// CSI <32>[:shifted[:base]] [; 1 [:event]] u  — unmodified space in kitty encoding.
const KITTY_SPACE = /^\x1b\[32(?::\d*)*(?:;1(?::([123]))?)?u$/;
const ANY_RELEASE = /\x1b\[[\d:;]*:3[u~ABCDHFPQS]/;

export function classifySpace(data: string): SpaceEvent | undefined {
  if (data === " ") return "press";
  const match = KITTY_SPACE.exec(data);
  if (!match) return undefined;
  if (match[1] === "2") return "repeat";
  if (match[1] === "3") return "release";
  return "press";
}

export function isAnyKeyRelease(data: string): boolean {
  return !data.includes("\x1b[200~") && ANY_RELEASE.test(data);
}

type State =
  | { kind: "idle" }
  | { kind: "kittyPending" }
  | { kind: "recording"; path: "kitty" | "repeat" }
  /** Hold was cancelled (error/toggle): swallow spaces until the key is released, without restarting. */
  | { kind: "draining"; path: "kitty" | "repeat" };

export class SpaceHoldDetector {
  private state: State = { kind: "idle" };
  private sawRelease = false;
  private timer: unknown;
  // Repeat-path run tracking.
  private lastSpaceAt = -Infinity;
  private rapid = 0;
  private passedInRun = 0;
  private leadIn = 0;
  private interval = 0;

  private readonly deps: HoldDetectorDeps;
  private readonly t: HoldThresholds;

  constructor(deps: HoldDetectorDeps, thresholds: HoldThresholds = DEFAULT_THRESHOLDS) {
    this.deps = deps;
    this.t = thresholds;
  }

  get phase(): State["kind"] {
    return this.state.kind;
  }

  get kittyPath(): boolean {
    return this.sawRelease && this.deps.kittyActive();
  }

  /** Feed raw terminal input. Returns what pi should do with it. */
  handle(data: string): InputResult {
    const event = classifySpace(data);
    if (event === undefined) {
      if (isAnyKeyRelease(data)) {
        this.sawRelease = true;
        return undefined;
      }
      return this.otherKey();
    }
    if (event === "release") this.sawRelease = true;

    const s = this.state;
    if (s.kind === "recording" || s.kind === "draining") {
      if (s.path === "kitty" || event === "release") {
        if (event === "release") {
          this.finishHold();
          return { consume: true };
        }
        // Text keys repeat as plain text even under kitty (only release is encoded),
        // so a bare " " is a repeat; only an encoded press means we missed the release.
        if (event === "press" && s.path === "kitty" && data !== " ") {
          this.finishHold();
          return { consume: true };
        }
        return { consume: true };
      }
      // Repeat path: each repeat extends the hold.
      this.noteInterval();
      this.armReleaseTimer();
      return { consume: true };
    }

    if (s.kind === "kittyPending") {
      if (event === "release") {
        this.clearTimer();
        this.state = { kind: "idle" };
        return undefined;
      }
      // Repeats while waiting would type extra spaces.
      return { consume: true };
    }

    // idle
    if (event === "release") return undefined;
    if (this.kittyPath) {
      if (event === "repeat") return { consume: true }; // stray repeat, nothing to do
      this.state = { kind: "kittyPending" };
      this.clearTimer();
      this.timer = this.deps.setTimer(() => {
        this.timer = undefined;
        if (this.state.kind !== "kittyPending") return;
        this.state = { kind: "recording", path: "kitty" };
        this.deps.deleteSpaces(1);
        this.deps.onStart();
      }, this.t.kittyHoldMs);
      return undefined; // the press types its space
    }
    return this.repeatPathSpace();
  }

  /** Stop listening for a hold that is no longer wanted (error, voice off). Swallows the rest of the hold. */
  cancel(): void {
    const s = this.state;
    if (s.kind === "recording") {
      this.state = { kind: "draining", path: s.path };
      if (s.path === "repeat") this.armReleaseTimer();
    } else if (s.kind === "kittyPending") {
      this.clearTimer();
      this.state = { kind: "idle" };
    }
  }

  /** Forget everything (focus moved away, shutdown). Does not call onStop. */
  reset(): void {
    this.clearTimer();
    this.state = { kind: "idle" };
    this.resetRun();
  }

  dispose(): void {
    this.reset();
  }

  private repeatPathSpace(): InputResult {
    const now = this.deps.now();
    const gap = now - this.lastSpaceAt;
    this.lastSpaceAt = now;
    if (gap <= this.t.repeatGapMs) {
      this.rapid += 1;
      this.passedInRun += 1;
      this.interval = gap;
    } else {
      this.leadIn = this.passedInRun === 1 && gap <= this.t.initialDelayMaxMs ? 1 : 0;
      this.rapid = 0;
      this.passedInRun = 1;
    }
    if (this.rapid < this.t.repeatCount) return undefined;

    // Hold: this space is consumed and the ones already typed are removed.
    const typed = this.passedInRun - 1 + this.leadIn;
    this.resetRunCounters();
    this.state = { kind: "recording", path: "repeat" };
    this.armReleaseTimer();
    if (typed > 0) this.deps.deleteSpaces(typed);
    this.deps.onStart();
    return { consume: true };
  }

  private otherKey(): InputResult {
    const s = this.state;
    if (s.kind === "recording" && s.path === "repeat") {
      // Typing another key ends the hold; let the key through.
      this.finishHold();
    } else if (s.kind === "draining" && s.path === "repeat") {
      this.clearTimer();
      this.state = { kind: "idle" };
    }
    this.resetRun();
    return undefined;
  }

  private noteInterval(): void {
    const now = this.deps.now();
    const gap = now - this.lastSpaceAt;
    this.lastSpaceAt = now;
    if (gap > 0 && gap <= this.t.repeatGapMs * 2) this.interval = gap;
  }

  private releaseGap(): number {
    return Math.max(this.t.releaseGapMinMs, this.interval * this.t.releaseGapFactor);
  }

  private armReleaseTimer(): void {
    this.clearTimer();
    this.timer = this.deps.setTimer(() => {
      this.timer = undefined;
      this.finishHold();
    }, this.releaseGap());
  }

  private finishHold(): void {
    this.clearTimer();
    const wasRecording = this.state.kind === "recording";
    this.state = { kind: "idle" };
    this.resetRun();
    if (wasRecording) this.deps.onStop();
  }

  private resetRunCounters(): void {
    this.rapid = 0;
    this.passedInRun = 0;
    this.leadIn = 0;
  }

  private resetRun(): void {
    this.resetRunCounters();
    this.lastSpaceAt = -Infinity;
  }

  private clearTimer(): void {
    if (this.timer !== undefined) this.deps.clearTimer(this.timer);
    this.timer = undefined;
  }
}
