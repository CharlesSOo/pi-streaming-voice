/**
 * Push-to-talk detection for the voice hotkey.
 *
 * Hold mode is driven by the OS auto-repeat of the held key: a hold is known
 * to be alive only while repeats keep coming, so every hold ends when they
 * stop for the release gap (or on the release event, where there is one).
 *
 * Space (the only hotkey that also types) is always hold-to-talk, on two paths:
 *  - Kitty: the terminal reports key releases (pi-tui requests flags 7). The
 *    press types a space; the first auto-repeat (plain or encoded) makes it a
 *    hold: the typed space is removed and recording starts. A plain space
 *    sooner after the press than any OS initial repeat delay (`textGapMs`) is
 *    typed as text; if the spaces keep coming past that delay it was a hold
 *    after all (the press and its first repeats were processed late, close
 *    together), and every space typed since the press is removed.
 *  - Repeat timing (no release events): a run of `repeatCount` consecutive
 *    gaps of at most `repeatGapMs` is a hold; the spaces typed so far are
 *    removed.
 * The kitty path is used only once a key release event has actually been seen,
 * because a terminal can answer the kitty query without supporting event types.
 *
 * A combo (ctrl/alt/super) types nothing, so it starts recording on the press:
 *  - hold: the release stops it, and so does `noRepeatMs` without a repeat.
 *    Needs release events, i.e. the kitty protocol.
 *  - tap: the next press, or Escape, stops it. Also used for a hold-mode combo
 *    when the terminal has no release events.
 *
 * When the repeats of a kitty-path hold stop without a release (a stall, or a
 * lost release), the take ends; if the hotkey then repeats again within
 * `noRepeatMs`, the key is still down and recording resumes at once.
 */
import { isKeyRelease, matchesKey } from "@earendil-works/pi-tui";
import { classifyHotkey, DEFAULT_HOTKEY, isCombo, splitKeyId, type HotkeyEvent, type KeyParts, type VoiceMode } from "./hotkey.ts";

export interface HoldThresholds {
  /** Kitty, Space: a plain space sooner than this after the press is text, not (yet) an auto-repeat. */
  textGapMs: number;
  /** Longest OS initial repeat delay: a held key has repeated by then. */
  noRepeatMs: number;
  /** Repeat path: max gap between auto-repeated spaces. */
  repeatGapMs: number;
  /** Repeat path: consecutive rapid gaps needed to call it a hold. */
  repeatCount: number;
  /** Repeat path: a space this soon before the first repeat is the press of the hold, and is removed too. */
  initialDelayMaxMs: number;
  /** Minimum silence after the last repeat that counts as release. */
  releaseGapMinMs: number;
  /** Release gap is at least this multiple of the observed repeat interval. */
  releaseGapFactor: number;
}

export const DEFAULT_THRESHOLDS: HoldThresholds = {
  textGapMs: 120,
  noRepeatMs: 2000,
  repeatGapMs: 125,
  repeatCount: 2,
  initialDelayMaxMs: 650,
  releaseGapMinMs: 500,
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
  // Timing of hotkey events during a hold.
  private lastAt = -Infinity;
  private interval = 0;
  /** Kitty path: when the Space that may become a hold was pressed, and the spaces typed since (it included). */
  private pressAt = -Infinity;
  private typed = 0;
  /** When the repeats of a kitty-path hold stopped without a release: more repeats soon after resume it. */
  private cutAt = -Infinity;
  /** Tap: the last hotkey press, and whether the key was released since. */
  private tapAt = -Infinity;
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
    this.tapAt = -Infinity;
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
    if (s.kind !== "recording") return;
    if (s.how === "tap") {
      this.clearTimer();
      this.state = { kind: "idle" };
    } else {
      // The watchdog armed for the hold ends the draining too.
      this.state = { kind: "draining", how: s.how };
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
      this.cutAt = -Infinity;
      if (s.kind !== "idle" && s.how === "kitty") this.finishHold();
      return CONSUME;
    }
    const now = this.deps.now();
    if (this.effectiveMode === "tap") {
      if (event === "press") this.tapPress(now);
      return CONSUME;
    }
    if (s.kind === "idle") {
      // A repeat with nothing recording is the key still down after the watchdog cut its take.
      if (event === "press") this.startHeld(now, this.t.noRepeatMs);
      else if (now - this.cutAt <= this.t.noRepeatMs) this.startHeld(now, this.releaseGap());
      return CONSUME;
    }
    // A fresh press while we think the key is down means its release was lost.
    if (event === "press") this.finishHold();
    else this.noteRepeat();
    return CONSUME;
  }

  /**
   * Tap mode. Where the terminal reports releases, a press after a release
   * toggles at once. Otherwise a held key looks like a stream of presses: a
   * press within the repeat gap of another is auto-repeat, and a lone press
   * toggles once the repeat gap has passed with nothing following.
   */
  private tapPress(now: number): void {
    const gap = now - this.tapAt;
    const released = this.released;
    this.tapAt = now;
    this.released = false;
    this.clearTimer();
    if (!released && gap <= this.t.repeatGapMs) return;
    // Nothing can be repeating before the first press, or this long after the last one.
    if (released || (this.state.kind === "idle" && gap > this.t.noRepeatMs)) {
      this.toggleTap();
      return;
    }
    this.timer = this.deps.setTimer(() => {
      this.timer = undefined;
      this.toggleTap();
    }, this.t.repeatGapMs);
  }

  private toggleTap(): void {
    if (this.state.kind !== "idle") {
      this.finishHold();
      return;
    }
    this.state = { kind: "recording", how: "tap" };
    this.deps.onStart();
  }

  private spaceEvent(event: HotkeyEvent, data: string): InputResult {
    const s = this.state;
    if (s.kind !== "idle") {
      // Text keys repeat as plain text even under kitty (only release is encoded),
      // so a bare " " is a repeat; only an encoded press means we missed the release.
      if (event === "release" || (s.how === "kitty" && event === "press" && data !== " ")) this.finishHold();
      else this.noteRepeat(); // each repeat extends the hold
      return CONSUME;
    }

    if (event === "release") {
      this.pressAt = -Infinity;
      this.typed = 0;
      this.cutAt = -Infinity;
      return undefined;
    }
    if (!this.sawRelease || !this.deps.kittyActive()) return this.repeatPathSpace();

    const now = this.deps.now();
    if (now - this.cutAt <= this.t.noRepeatMs) {
      // Still down after the watchdog cut its take.
      this.startHeld(now, this.releaseGap());
      return CONSUME;
    }
    const gap = now - this.pressAt;
    if (gap <= this.t.noRepeatMs) {
      // An encoded repeat is one for certain; a plain space is one if it comes no sooner than an OS initial delay.
      if (event === "repeat" || gap >= this.t.textGapMs) {
        this.deps.deleteSpaces(this.typed);
        this.startHeld(now, this.releaseGap());
        return CONSUME;
      }
      // Too soon to tell text from a press whose repeats were processed late: typed for now, counted from the press.
      this.typed += 1;
      return undefined;
    }
    if (event === "repeat") return CONSUME; // stray repeat, nothing to do
    this.pressAt = now;
    this.typed = 1;
    return undefined; // the press types its space
  }

  /** The key is down on the kitty path: record until its release, or until `watchdogMs` pass without a repeat. */
  private startHeld(now: number, watchdogMs: number): void {
    this.pressAt = -Infinity;
    this.typed = 0;
    this.cutAt = -Infinity;
    this.lastAt = now;
    this.interval = 0;
    this.state = { kind: "recording", how: "kitty" };
    this.armWatchdog(watchdogMs);
    this.deps.onStart();
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
    this.armWatchdog(this.releaseGap());
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
    }
    if (this.state.kind === "idle") this.resetRun();
    return undefined;
  }

  /** A repeat of the held hotkey: measure the interval and watch for the repeats stopping. */
  private noteRepeat(): void {
    const now = this.deps.now();
    const gap = now - this.lastAt;
    this.lastAt = now;
    if (gap > 0 && gap <= this.t.repeatGapMs * 2) this.interval = gap;
    this.armWatchdog(this.releaseGap());
  }

  private releaseGap(): number {
    return Math.max(this.t.releaseGapMinMs, this.interval * this.t.releaseGapFactor);
  }

  /** End the hold if no hotkey event arrives for `ms`. */
  private armWatchdog(ms: number): void {
    this.clearTimer();
    this.timer = this.deps.setTimer(() => {
      // Let input that queued up behind a busy event loop arrive before calling it a release.
      this.timer = this.deps.setTimer(() => {
        this.timer = undefined;
        this.finishHold(true);
      }, 0);
    }, ms);
  }

  /** `cut`: the repeats stopped without a release, so the key may still be down. */
  private finishHold(cut = false): void {
    this.clearTimer();
    const s = this.state;
    this.state = { kind: "idle" };
    this.resetRun();
    if (cut && s.kind === "recording" && s.how === "kitty") this.cutAt = this.deps.now();
    if (s.kind === "recording") this.deps.onStop();
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
    this.pressAt = -Infinity;
    this.typed = 0;
    this.cutAt = -Infinity;
  }

  private clearTimer(): void {
    if (this.timer !== undefined) this.deps.clearTimer(this.timer);
    this.timer = undefined;
  }
}
