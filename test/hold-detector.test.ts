import { test } from "node:test";
import assert from "node:assert/strict";
import { classifySpace, DEFAULT_THRESHOLDS, SpaceHoldDetector, type InputResult } from "../src/hold-detector.ts";

const PRESS = " ";
const K_REPEAT = "\x1b[32;1:2u";
const K_RELEASE = "\x1b[32;1:3u";
const OTHER_RELEASE = "\x1b[97;1:3u";

class Harness {
  time = 0;
  kitty = false;
  timers = new Map<number, { at: number; fn: () => void }>();
  nextId = 1;
  log: string[] = [];
  detector: SpaceHoldDetector;

  constructor() {
    this.detector = new SpaceHoldDetector({
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

test("classifySpace", () => {
  assert.equal(classifySpace(" "), "press");
  assert.equal(classifySpace("\x1b[32u"), "press");
  assert.equal(classifySpace("\x1b[32;1:1u"), "press");
  assert.equal(classifySpace(K_REPEAT), "repeat");
  assert.equal(classifySpace(K_RELEASE), "release");
  assert.equal(classifySpace("\x1b[32;5u"), undefined); // ctrl+space
  assert.equal(classifySpace("a"), undefined);
  assert.equal(classifySpace("  "), undefined);
});

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
  assert.equal(h.detector.kittyPath, false);
  h.send(OTHER_RELEASE);
  assert.equal(h.detector.kittyPath, true);
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
  assert.deepEqual(h.send(K_REPEAT, 100), { consume: true });
  assert.deepEqual(h.send(K_REPEAT, 30), { consume: true });
  h.advance(5000); // holding silently (no repeats) keeps recording
  assert.deepEqual(h.log, ["delete:1", "start"]);
  assert.deepEqual(h.send(K_RELEASE), { consume: true });
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
