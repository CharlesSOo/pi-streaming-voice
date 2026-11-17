/**
 * Push-to-talk detection for the voice hotkey.
 *
 * Space (the only hotkey that also types) is always hold-to-talk, on two paths:
 *  - Kitty: the terminal reports real press/repeat/release events (pi-tui
 *    requests flags 7). The press types a space; if the key is still down after
 *    `kittyHoldMs`, it is a hold: the typed space is removed and recording
 *    starts. The release event stops recording.
 *  - Repeat timing (no release events): the terminal only sends auto-repeated
 *    spaces. A run of `repeatCount` consecutive gaps of at most `repeatGapMs`
 *    is a hold; the spaces typed so far are removed. Recording stops once no
 *    space arrives for the release gap.
 * The kitty path is used only once a key release event has actually been seen,
 * because a terminal can answer the kitty query without supporting event types.
 *
 * A combo (ctrl/alt/super) types nothing, so it starts recording on the press:
 *  - hold: the release stops it. Needs release events, i.e. the kitty protocol.
 *  - tap: the next press, or Escape, stops it. Also used for a hold-mode combo
 *    when the terminal has no release events.
 *
 * On every hold, once auto-repeats have been seen, repeats stopping for the
 * release gap ends the hold, so a lost release cannot leave it recording.
 */
import { isKeyRelease, matchesKey } from "@earendil-works/pi-tui";
import { classifyHotkey, DEFAULT_HOTKEY, isCombo, splitKeyId, type HotkeyEvent, type KeyParts, type VoiceMode } from "./hotkey.ts";

export interface HoldThresholds {
  /** Kitty, Space: key held this long without release = hold. */
  kittyHoldMs: number;
  /** Repeat path: max gap between auto-repeated spaces. */
  repeatGapMs: number;
  /** Repeat path: consecutive rapid gaps needed to call it a hold. */
  repeatCount: number;
  /** Max gap between the physical press and its first repeat (the OS initial repeat delay). */
  initialDelayMaxMs: number;
  /** Minimum silence after the last repeat that counts as release. */
  releaseGapMinMs: number;
  /** Release gap is at least this multiple of the observed repeat interval. */
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
  /** Recording should start. */
  onStart(): void;
  /** Recording should stop. */
  onStop(): void;
  /** Remove `count` spaces the hotkey typed before it turned out to be a hold. */
  deleteSpaces(count: number): void;
}

export type InputResult = { consume?: boolean; data?: string } | undefined;

export const BACKSPACE = "\x7f";

const CONSUME: InputResult = { consume: true };

type Held = "kitty" | "repeat";

type State =
  | { kind: "idle" }
  /** Space is down on the kitty path, not yet long enough to be a hold. */
  | { kind: "pending" }
  | { kind: "recording"; how: Held | "tap" }
  /** Hold was cancelled (error/toggle): swallow the hotkey until it is released, without restarting. */
  | { kind: "draining"; how: Held };

export class HotkeyDetector {
  private state: State = { kind: "idle" };
  private hotkey: KeyParts = splitKeyId(DEFAULT_HOTKEY);
  private combo = false;
  private mode: VoiceMode = "hold";
  private sawRelease = false;
  private timer: unknown;
  // Timing of hotkey events.
  private lastAt = -Infinity;
  private interval = 0;
  /** Tap: the hotkey was released since its last press. */
  private released = true;
  // Repeat-path run tracking.
  private rapid = 0;
  private passedInRun = 0;
  private leadIn = 0;

  private readonly deps: HoldDetectorDeps;
  private readonly t: HoldThresholds;

  constructor(deps: HoldDetectorDeps, thresholds: HoldThresholds = DEFAULT_THRESHOLDS) {
    this.deps = deps;
    this.t = thresholds;
  }

  /** Change the hotkey (a pi key id) and mode. Forgets any hold in progress. */
  configure(hotkey: string, mode: VoiceMode): void {
    this.reset();
    this.hotkey = splitKeyId(hotkey);
    this.combo = isCombo(this.hotkey);
    this.mode = mode;
    this.released = true;
  }

  get phase(): State["kind"] {
    return this.state.kind;
  }

  /** How the hotkey behaves right now: a combo falls back to tap where releases are not reported. */
  get effectiveMode(): VoiceMode {
    if (!this.combo) return "hold";
    return this.mode === "tap" || !this.deps.kittyActive() ? "tap" : "hold";
  }

  /** Feed raw terminal input. Returns what pi should do with it. */
  handle(data: string): InputResult {
    const event = classifyHotkey(data, this.hotkey);
    if (event === undefined) {
      if (isKeyRelease(data)) {
        this.sawRelease = true;
        return undefined;
      }
      return this.otherKey(data);
    }
    if (event === "release") this.sawRelease = true;
    return this.combo ? this.comboEvent(event) : this.spaceEvent(event, data);
  }

  /** Stop listening for a hold that is no longer wanted (error, voice off). Swallows the rest of the hold. */
  cancel(): void {
    const s = this.state;
    if (s.kind === "recording") {
      if (s.how === "tap") {
        this.state = { kind: "idle" };
        return;
      }
      this.state = { kind: "draining", how: s.how };
      if (s.how === "repeat") this.armReleaseTimer();
    } else if (s.kind === "pending") {
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

  private comboEvent(event: HotkeyEvent): InputResult {
    const s = this.state;
    if (event === "release") {
      this.released = true;
      if (s.kind !== "idle" && s.kind !== "pending" && s.how === "kitty") this.finishHold();
      return CONSUME;
    }
    const now = this.deps.now();
    if (this.effectiveMode === "tap") {
      // Without repeat events a held key looks like a burst of presses.
      const repeat = event === "repeat" || (!this.released && now - this.lastAt <= this.t.initialDelayMaxMs);
      this.lastAt = now;
      this.released = false;
      if (repeat) return CONSUME;
      if (s.kind === "idle") {
        this.state = { kind: "recording", how: "tap" };
        this.deps.onStart();
      } else {
        this.finishHold();
      }
      return CONSUME;
    }
    if (s.kind === "idle") {
      if (event === "press") {
        this.lastAt = now;
        this.state = { kind: "recording", how: "kitty" };
        this.deps.onStart();
      }
      return CONSUME;
    }
    // A fresh press while we think the key is down means its release was lost.
    if (event === "press") this.finishHold();
    else this.noteRepeat();
    return CONSUME;
  }

  private spaceEvent(event: HotkeyEvent, data: string): InputResult {
    const s = this.state;
    if (s.kind === "recording" || s.kind === "draining") {
      // Text keys repeat as plain text even under kitty (only release is encoded),
      // so a bare " " is a repeat; only an encoded press means we missed the release.
      if (event === "release" || (s.how === "kitty" && event === "press" && data !== " ")) {
        this.finishHold();
        return CONSUME;
      }
      // Each repeat extends the hold.
      this.noteRepeat(s.how === "repeat");
      return CONSUME;
    }

    if (s.kind === "pending") {
      if (event === "release") {
        this.clearTimer();
        this.state = { kind: "idle" };
        return undefined;
      }
      // Repeats while waiting would type extra spaces.
      this.noteInterval();
      return CONSUME;
    }

    // idle
    if (event === "release") return undefined;
    if (this.sawRelease && this.deps.kittyActive()) {
      if (event === "repeat") return CONSUME; // stray repeat, nothing to do
      this.state = { kind: "pending" };
      this.lastAt = this.deps.now();
      this.interval = 0;
      this.clearTimer();
      this.timer = this.deps.setTimer(() => {
        this.timer = undefined;
        if (this.state.kind !== "pending") return;
        this.state = { kind: "recording", how: "kitty" };
        this.deps.deleteSpaces(1);
        this.deps.onStart();
        if (this.state.kind === "recording" && this.interval > 0) this.armReleaseTimer();
      }, this.t.kittyHoldMs);
      return undefined; // the press types its space
    }
    return this.repeatPathSpace();
  }

  private repeatPathSpace(): InputResult {
    const now = this.deps.now();
    const gap = now - this.lastAt;
    this.lastAt = now;
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
    this.state = { kind: "recording", how: "repeat" };
    this.armReleaseTimer();
    if (typed > 0) this.deps.deleteSpaces(typed);
    this.deps.onStart();
    return CONSUME;
  }

  private otherKey(data: string): InputResult {
    const s = this.state;
    if (s.kind === "recording" && s.how === "tap") {
      if (!matchesKey(data, "escape")) return undefined;
      this.finishHold();
      return CONSUME;
    }
    if (s.kind === "recording" && s.how === "repeat") {
      // Typing another key ends the hold; let the key through.
      this.finishHold();
    } else if (s.kind === "draining" && s.how === "repeat") {
      this.clearTimer();
      this.state = { kind: "idle" };
    } else if (s.kind === "pending") {
      // Space then more typing while it is still down: a typed space, not a hold.
      this.clearTimer();
      this.state = { kind: "idle" };
    }
    if (this.state.kind === "idle") this.resetRun();
    return undefined;
  }

  /** A repeat of the held hotkey: measure the interval and, once it is known, watch for the repeats stopping. */
  private noteRepeat(always = false): void {
    this.noteInterval();
    if (always || this.interval > 0) this.armReleaseTimer();
  }

  private noteInterval(): void {
    const now = this.deps.now();
    const gap = now - this.lastAt;
    this.lastAt = now;
    if (gap > 0 && gap <= this.t.repeatGapMs * 2) this.interval = gap;
  }

  private releaseGap(): number {
    return Math.max(this.t.releaseGapMinMs, this.interval * this.t.releaseGapFactor);
  }

  private armReleaseTimer(): void {
    this.clearTimer();
    this.timer = this.deps.setTimer(() => {
      // Let input that queued up behind a busy event loop arrive before calling it a release.
      this.timer = this.deps.setTimer(() => {
        this.timer = undefined;
        this.finishHold();
      }, 0);
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
    this.lastAt = -Infinity;
    this.interval = 0;
  }

  private clearTimer(): void {
    if (this.timer !== undefined) this.deps.clearTimer(this.timer);
    this.timer = undefined;
  }
}
