import { test } from "node:test";
import assert from "node:assert/strict";
import { DEFAULT_THRESHOLDS, HotkeyDetector, type InputResult } from "../src/hold-detector.ts";
import type { VoiceMode } from "../src/hotkey.ts";

const PRESS = " ";
const K_REPEAT = "\x1b[32;1:2u";
const K_RELEASE = "\x1b[32;1:3u";
const OTHER_RELEASE = "\x1b[97;1:3u";
// What Rex sends for `rex send-key --action release shift+space`.
const K_RELEASE_SHIFT = "\x1b[32;2:3u";
// Kitty: caps_lock = 64, so the modifier field is 1 + 64.
const K_RELEASE_CAPS = "\x1b[32;65:3u";
// alt+v as Rex encodes it under kitty flags 7.
const ALT_V = "\x1b[118;3u";
const ALT_V_REPEAT = "\x1b[118;3:2u";
const ALT_V_RELEASE = "\x1b[118;3:3u";
const ESCAPE = "\x1b[27u";

class Harness {
  time = 0;
  kitty = false;
  timers = new Map<number, { at: number; fn: () => void }>();
  nextId = 1;
  log: string[] = [];
  detector: HotkeyDetector;

  constructor(hotkey = "space", mode: VoiceMode = "hold") {
    this.detector = new HotkeyDetector({
      now: () => this.time,
      setTimer: (fn, ms) => {
        const id = this.nextId++;
        this.timers.set(id, { at: this.time + ms, fn });
        return id;
      },
      clearTimer: (h) => {
        this.timers.delete(h as number);
      },
      kittyActive: () => this.kitty,
      onStart: () => this.log.push("start"),
      onStop: () => this.log.push("stop"),
      deleteSpaces: (n) => this.log.push(`delete:${n}`),
    });
    this.detector.configure(hotkey, mode);
  }

  advance(ms: number): void {
    const target = this.time + ms;
    for (;;) {
      let next: [number, { at: number; fn: () => void }] | undefined;
      for (const entry of this.timers) if (entry[1].at <= target && (!next || entry[1].at < next[1].at)) next = entry;
      if (!next) break;
      this.timers.delete(next[0]);
      this.time = next[1].at;
      next[1].fn();
    }
    this.time = target;
  }

  /** Send input after `ms` elapse. */
  send(data: string, ms = 0): InputResult {
    this.advance(ms);
    return this.detector.handle(data);
  }
}

/** Simulates a held key on a legacy terminal: press, initial delay, then repeats. */
function holdLegacy(h: Harness, repeats: number, initialDelay = 400, interval = 50): InputResult[] {
  const out = [h.send(PRESS)];
  out.push(h.send(PRESS, initialDelay));
  for (let i = 1; i < repeats; i += 1) out.push(h.send(PRESS, interval));
  return out;
}

// ---- repeat-timing path ----

test("repeat path: a single tap types a space", () => {
  const h = new Harness();
  assert.equal(h.send(PRESS), undefined);
  h.advance(2000);
  assert.deepEqual(h.log, []);
  assert.equal(h.detector.phase, "idle");
});

test("repeat path: normal typing with spaces never triggers", () => {
  const h = new Harness();
  for (const ch of "hello world this is fast typing  ok") {
    assert.equal(h.send(ch === " " ? PRESS : ch, 60), undefined);
  }
  // Two quick spaces (a deliberate double space) still type.
  assert.equal(h.send(PRESS, 200), undefined);
  assert.equal(h.send(PRESS, 90), undefined);
  h.advance(1000);
  assert.deepEqual(h.log, []);
});

test("repeat path: hold starts recording and removes typed spaces", () => {
  const h = new Harness();
  const results = holdLegacy(h, 2);
  // press + first repeat typed, second rapid repeat... not yet (needs 2 rapid gaps)
  assert.deepEqual(results, [undefined, undefined, undefined]);
  const r = h.send(PRESS, 50); // second rapid gap -> hold
  assert.deepEqual(r, { consume: true });
  assert.deepEqual(h.log, ["delete:3", "start"]);
  assert.equal(h.detector.phase, "recording");
});

test("repeat path: repeats keep recording, gap releases", () => {
  const h = new Harness();
  holdLegacy(h, 3);
  assert.deepEqual(h.log, ["delete:3", "start"]);
  for (let i = 0; i < 20; i += 1) assert.deepEqual(h.send(PRESS, 50), { consume: true });
  h.advance(DEFAULT_THRESHOLDS.releaseGapMinMs - 10);
  assert.deepEqual(h.log, ["delete:3", "start"]);
  h.advance(20);
  assert.deepEqual(h.log, ["delete:3", "start", "stop"]);
  assert.equal(h.detector.phase, "idle");
  // Next tap types normally.
  assert.equal(h.send(PRESS, 500), undefined);
});

test("repeat path: release gap scales with slow repeat rate", () => {
  const h = new Harness();
  holdLegacy(h, 3, 400, 110);
  assert.deepEqual(h.log, ["delete:3", "start"]);
  h.send(PRESS, 110);
  h.advance(260); // 2.5 × 110 = 275
  assert.deepEqual(h.log, ["delete:3", "start"]);
  h.advance(20);
  assert.deepEqual(h.log, ["delete:3", "start", "stop"]);
});

test("repeat path: press preceded by a long pause is not deleted", () => {
  const h = new Harness();
  h.send(PRESS); // a deliberate space
  // ... long pause, then a hold whose initial delay is too long to link
  h.send(PRESS, 2000);
  h.send(PRESS, 400);
  h.send(PRESS, 50);
  const r = h.send(PRESS, 50);
  // run: press(at 2000), repeat, repeat, (this) -> 2 typed + leadIn 1 (press at 2000 linked to repeat at +400)
  assert.deepEqual(r, { consume: true });
  assert.deepEqual(h.log, ["delete:3", "start"]);
});

test("repeat path: another key ends recording and passes through", () => {
  const h = new Harness();
  holdLegacy(h, 3);
  assert.equal(h.send("a", 30), undefined);
  assert.deepEqual(h.log, ["delete:3", "start", "stop"]);
});

test("repeat path: cancel swallows the rest of the hold without restarting", () => {
  const h = new Harness();
  holdLegacy(h, 3);
  h.detector.cancel();
  for (let i = 0; i < 10; i += 1) assert.deepEqual(h.send(PRESS, 50), { consume: true });
  h.advance(500);
  assert.deepEqual(h.log, ["delete:3", "start"]);
  assert.equal(h.detector.phase, "idle");
});

// ---- kitty path ----

function kittyHarness(): Harness {
  const h = new Harness();
  h.kitty = true;
  // The kitty path is trusted only after a real release event is seen.
  h.send(OTHER_RELEASE);
  return h;
}

test("kitty path: not used until a release event is seen", () => {
  const h = new Harness();
  h.kitty = true;
  h.send(PRESS);
  h.advance(1000); // no threshold timer on the repeat path
  assert.deepEqual(h.log, []);
  h.send(OTHER_RELEASE);
  h.send(PRESS, 1000);
  h.advance(DEFAULT_THRESHOLDS.kittyHoldMs);
  assert.deepEqual(h.log, ["delete:1", "start"]);
});

test("kitty path: a tap types a space", () => {
  const h = kittyHarness();
  assert.equal(h.send(PRESS), undefined);
  assert.equal(h.send(K_RELEASE, 80), undefined);
  h.advance(1000);
  assert.deepEqual(h.log, []);
});

test("kitty path: hold starts after threshold, deletes the typed space, release stops", () => {
  const h = kittyHarness();
  assert.equal(h.send(PRESS), undefined);
  h.advance(DEFAULT_THRESHOLDS.kittyHoldMs - 1);
  assert.deepEqual(h.log, []);
  h.advance(1);
  assert.deepEqual(h.log, ["delete:1", "start"]);
  h.advance(5000); // holding silently (key repeat off) keeps recording
  assert.deepEqual(h.log, ["delete:1", "start"]);
  assert.deepEqual(h.send(K_REPEAT, 100), { consume: true });
  assert.deepEqual(h.send(K_REPEAT, 30), { consume: true });
  assert.deepEqual(h.send(K_RELEASE, 30), { consume: true });
  assert.deepEqual(h.log, ["delete:1", "start", "stop"]);
});

test("kitty path: repeats before the threshold are swallowed", () => {
  const h = kittyHarness();
  h.send(PRESS);
  assert.deepEqual(h.send(K_REPEAT, 300), { consume: true });
});

test("kitty path: plain-text repeats (Rex, kitty without flag 8) keep recording", () => {
  const h = kittyHarness();
  h.send(PRESS);
  h.advance(400);
  for (let i = 0; i < 20; i += 1) assert.deepEqual(h.send(PRESS, 30), { consume: true });
  assert.deepEqual(h.log, ["delete:1", "start"]);
  assert.deepEqual(h.send(K_RELEASE, 30), { consume: true });
  assert.deepEqual(h.log, ["delete:1", "start", "stop"]);
});

test("kitty path: an encoded press while recording means a missed release", () => {
  const h = kittyHarness();
  h.send(PRESS);
  h.advance(400);
  assert.deepEqual(h.send("\x1b[32u", 100), { consume: true });
  assert.deepEqual(h.log, ["delete:1", "start", "stop"]);
});

test("kitty path: cancel drains until release", () => {
  const h = kittyHarness();
  h.send(PRESS);
  h.advance(400);
  h.detector.cancel();
  assert.deepEqual(h.send(K_REPEAT, 50), { consume: true });
  assert.deepEqual(h.send(K_RELEASE, 50), { consume: true });
  assert.deepEqual(h.log, ["delete:1", "start"]);
  assert.equal(h.detector.phase, "idle");
});

test("reset clears a pending hold without callbacks", () => {
  const h = kittyHarness();
  h.send(PRESS);
  h.detector.reset();
  h.advance(1000);
  assert.deepEqual(h.log, []);
});

test("release seen mid-hold on the repeat path still stops", () => {
  const h = new Harness();
  h.kitty = true; // kitty negotiated, but no release seen yet -> repeat path
  h.send(PRESS);
  h.send(K_REPEAT, 400);
  h.send(K_REPEAT, 50);
  h.send(K_REPEAT, 50);
  assert.deepEqual(h.log, ["delete:3", "start"]);
  assert.deepEqual(h.send(K_RELEASE, 50), { consume: true });
  assert.deepEqual(h.log, ["delete:3", "start", "stop"]);
});

test("kitty path: a release with Shift or Caps Lock down still ends a tap", () => {
  for (const release of [K_RELEASE_SHIFT, K_RELEASE_CAPS]) {
    const h = kittyHarness();
    assert.equal(h.send(PRESS), undefined); // types a space
    assert.equal(h.send(release, 80), undefined);
    assert.equal(h.send("I", 40), undefined);
    h.advance(2000);
    assert.deepEqual(h.log, [], JSON.stringify(release));
  }
});

test("kitty path: releasing a hold with Shift down stops recording", () => {
  const h = kittyHarness();
  h.send(PRESS);
  h.advance(400);
  assert.deepEqual(h.send(K_RELEASE_SHIFT, 1000), { consume: true });
  assert.deepEqual(h.log, ["delete:1", "start", "stop"]);
});

test("kitty path: typing on before the threshold cancels the pending hold", () => {
  const h = kittyHarness();
  assert.equal(h.send(PRESS), undefined);
  assert.equal(h.send("x", 60), undefined);
  assert.equal(h.send("y", 60), undefined);
  h.advance(400); // Space still down
  assert.deepEqual(h.log, []);
  assert.equal(h.detector.phase, "idle");
});

test("kitty path: a lost release ends the hold once the repeats stop", () => {
  const h = kittyHarness();
  h.send(PRESS);
  h.advance(400);
  for (let i = 0; i < 20; i += 1) h.send(PRESS, 30); // then the release goes elsewhere
  h.advance(DEFAULT_THRESHOLDS.releaseGapMinMs - 10);
  assert.deepEqual(h.log, ["delete:1", "start"]);
  h.advance(10);
  assert.deepEqual(h.log, ["delete:1", "start", "stop"]);
  assert.equal(h.detector.phase, "idle");
});

test("kitty path: a cancelled hold whose release is lost stops swallowing Space", () => {
  const h = kittyHarness();
  h.send(PRESS);
  h.advance(400);
  for (let i = 0; i < 5; i += 1) h.send(PRESS, 30);
  h.detector.cancel();
  h.advance(1000);
  assert.equal(h.detector.phase, "idle");
  assert.equal(h.send(PRESS), undefined);
});

// ---- combo hotkey ----

function comboHarness(mode: VoiceMode = "hold", kitty = true): Harness {
  const h = new Harness("alt+v", mode);
  h.kitty = kitty;
  return h;
}

test("combo hold: starts on the press, types nothing, stops on release", () => {
  const h = comboHarness();
  assert.equal(h.detector.effectiveMode, "hold");
  assert.deepEqual(h.send(ALT_V), { consume: true });
  assert.deepEqual(h.log, ["start"]);
  assert.deepEqual(h.send(ALT_V_REPEAT, 400), { consume: true });
  assert.deepEqual(h.send(ALT_V_REPEAT, 30), { consume: true });
  assert.deepEqual(h.send(ALT_V_RELEASE, 30), { consume: true });
  assert.deepEqual(h.log, ["start", "stop"]);
  assert.equal(h.detector.phase, "idle");
});

test("combo hold: Space and other keys are left alone", () => {
  const h = comboHarness();
  h.send(OTHER_RELEASE);
  for (const data of [PRESS, PRESS, PRESS, "v", "\x1b[118;5u", K_RELEASE]) assert.equal(h.send(data, 40), undefined);
  h.advance(1000);
  assert.deepEqual(h.log, []);
});

test("combo hold: release counts when alt came up first", () => {
  const h = comboHarness();
  h.send(ALT_V);
  assert.deepEqual(h.send("\x1b[118;1:3u", 500), { consume: true });
  assert.deepEqual(h.log, ["start", "stop"]);
});

test("combo hold: a lost release ends the hold once the repeats stop; without repeats a new press does", () => {
  const h = comboHarness();
  h.send(ALT_V);
  h.send(ALT_V_REPEAT, 400);
  for (let i = 0; i < 10; i += 1) h.send(ALT_V_REPEAT, 30);
  h.advance(10 * 60_000);
  assert.deepEqual(h.log, ["start", "stop"]);

  h.send(ALT_V);
  h.advance(60_000); // no repeats seen: nothing to go by
  assert.deepEqual(h.log, ["start", "stop", "start"]);
  assert.deepEqual(h.send(ALT_V), { consume: true });
  assert.deepEqual(h.log, ["start", "stop", "start", "stop"]);
});

test("combo hold: cancel drains until release", () => {
  const h = comboHarness();
  h.send(ALT_V);
  h.detector.cancel();
  assert.deepEqual(h.send(ALT_V_REPEAT, 400), { consume: true });
  assert.deepEqual(h.send(ALT_V_RELEASE, 50), { consume: true });
  assert.deepEqual(h.log, ["start"]);
  assert.equal(h.detector.phase, "idle");
});

test("tap: one press starts, the next press stops; repeats and releases change nothing", () => {
  const h = comboHarness("tap");
  assert.equal(h.detector.effectiveMode, "tap");
  assert.deepEqual(h.send(ALT_V), { consume: true });
  assert.deepEqual(h.send(ALT_V_REPEAT, 400), { consume: true });
  assert.deepEqual(h.send(ALT_V_RELEASE, 50), { consume: true });
  h.advance(60_000);
  assert.deepEqual(h.log, ["start"]);
  assert.equal(h.send("a"), undefined); // typing does not stop it
  assert.deepEqual(h.send(ALT_V, 100), { consume: true });
  assert.deepEqual(h.send(ALT_V_RELEASE, 50), { consume: true });
  assert.deepEqual(h.log, ["start", "stop"]);
  assert.equal(h.detector.phase, "idle");
});

test("tap: Escape stops and is swallowed; when idle it passes through", () => {
  const h = comboHarness("tap");
  assert.equal(h.send(ESCAPE), undefined);
  h.send(ALT_V);
  assert.deepEqual(h.send(ESCAPE, 1000), { consume: true });
  assert.deepEqual(h.log, ["start", "stop"]);
  assert.equal(h.send("\x1b", 10), undefined);
});

test("tap: a quick second tap stops (the release in between tells it from a repeat)", () => {
  const h = comboHarness("tap");
  h.send(ALT_V);
  h.send(ALT_V_RELEASE, 60);
  h.send(ALT_V, 100);
  assert.deepEqual(h.log, ["start", "stop"]);
});

test("tap: cancel returns to idle", () => {
  const h = comboHarness("tap");
  h.send(ALT_V);
  h.detector.cancel();
  assert.equal(h.detector.phase, "idle");
  h.send(ALT_V, 1000);
  assert.deepEqual(h.log, ["start", "start"]);
});

test("no release events: a hold-mode combo works as tap, and a held key is one press", () => {
  const h = comboHarness("hold", false);
  assert.equal(h.detector.effectiveMode, "tap");
  const LEGACY_ALT_V = "\x1bv";
  assert.deepEqual(h.send(LEGACY_ALT_V), { consume: true });
  assert.deepEqual(h.send(LEGACY_ALT_V, 400), { consume: true }); // auto-repeat of the same press
  for (let i = 0; i < 30; i += 1) assert.deepEqual(h.send(LEGACY_ALT_V, 35), { consume: true });
  h.advance(5000);
  assert.deepEqual(h.log, ["start"]);
  assert.deepEqual(h.send(LEGACY_ALT_V), { consume: true });
  assert.deepEqual(h.log, ["start", "stop"]);
});

test("no release events: Space hold still uses repeat timing", () => {
  const h = new Harness();
  assert.equal(h.detector.effectiveMode, "hold");
  holdLegacy(h, 3);
  assert.deepEqual(h.log, ["delete:3", "start"]);
});

test("configure forgets a hold in progress and switches key", () => {
  const h = comboHarness();
  h.send(ALT_V);
  h.detector.configure("super+k", "hold");
  assert.equal(h.detector.phase, "idle");
  assert.equal(h.send(ALT_V), undefined);
  assert.deepEqual(h.send("\x1b[107;9u"), { consume: true });
  assert.deepEqual(h.log, ["start", "start"]);
});
