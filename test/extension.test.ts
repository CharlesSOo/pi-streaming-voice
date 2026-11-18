// The extension end to end, minus network and microphone (see harness.ts).
import assert from "node:assert/strict";
import { test } from "node:test";
import { visibleWidth } from "@earendil-works/pi-tui";
import { readFileSync, writeFileSync } from "node:fs";
import type { Timings } from "../src/region-probe.ts";
import { activeTimers, ALT_V, ALT_V_RELEASE, FakeSocket, makeRig, mic, sleep, TEST_KEY, type Rig } from "./harness.ts";

const tick = () => sleep(5);
const ENTER = "\r";
const ESCAPE = "\x1b";
const DOWN = "\x1b[B";

/** Start a kitty-path Space take with the socket open. */
async function startTake(rig = makeRig()): Promise<Rig> {
  await rig.hold();
  await tick();
  rig.socket().open();
  return rig;
}

async function finishNormally(rig: Rig): Promise<void> {
  rig.release();
  await tick();
  rig.socket().final("", { from_finalize: true });
  await sleep(20);
}

/** Open /voice-settings and set the hotkey to alt+v. */
async function useAltV(rig: Rig, mode: "hold" | "tap" = "hold"): Promise<void> {
  void rig.command("voice-settings");
  rig.feed(DOWN);
  rig.feed(ENTER);
  rig.feed(ALT_V);
  if (mode === "tap") {
    rig.feed(DOWN);
    rig.feed(ENTER);
  }
  rig.feed(ESCAPE);
  await tick();
}

// ---------------------------------------------------------------- Space hold

test("tap types one space, no take", async () => {
  const rig = makeRig();
  rig.feed("\x1b[97;1:3u");
  assert.equal(rig.feed(" "), "passed");
  rig.feed("\x1b[32;1:3u");
  await sleep(400);
  assert.equal(rig.text(), " ");
  assert.equal(FakeSocket.instances.length, 0);
  assert.equal(rig.indicator(), "");
});

test("hold: space removed, live interims revised in place, final stays, never submits", async () => {
  const rig = makeRig();
  let submitted = 0;
  rig.editor.onSubmit = () => {
    submitted += 1;
  };
  rig.editor.setText("fix");
  await startTake(rig);
  assert.equal(rig.text(), "fix", "space typed by the press is removed");
  assert.match(rig.indicator(), /listening…$/);
  const drawn = rig.editor.render(60);
  assert.match(drawn[0] ?? "", /^─+ [▁-█]{4} listening… ─\x1b\[0m$/, "meter and label on the top border, no dot");
  assert.equal(visibleWidth(drawn[0] ?? ""), 60, "the border keeps its width");
  const s = rig.socket();
  assert.match(s.url, /^wss:\/\/api\.deepgram\.com\/v1\/listen\?/);
  assert.ok(!s.url.includes(TEST_KEY), "key must not be in the URL");
  assert.deepEqual(s.init, { headers: { Authorization: `Token ${TEST_KEY}` } });
  rig.recorder().opts.onChunk({ samples: new Float32Array(800).fill(0.1) });
  assert.equal(s.sent.length, 2, "the chunk the device delivered on start, and this one");
  s.interim("the bug in");
  assert.equal(rig.text(), "fix the bug in");
  s.interim("the bug in pie");
  assert.equal(rig.text(), "fix the bug in pie");
  s.final("The bug in Pi.");
  assert.equal(rig.text(), "fix The bug in Pi.");
  s.interim("and add");
  assert.equal(rig.text(), "fix The bug in Pi. and add");
  rig.release();
  await tick();
  assert.match(rig.indicator(), /transcribing…$/);
  assert.ok(s.json.some((j) => j.includes("Finalize")));
  s.final("And add tests.", { from_finalize: true });
  await sleep(20);
  assert.equal(rig.text(), "fix The bug in Pi. And add tests.");
  assert.equal(rig.indicator(), "");
  assert.ok(rig.recorder().stopped && rig.recorder().closed, "mic released");
  assert.equal(submitted, 0);
  assert.ok(rig.notifications.every((n) => !n.message.includes(TEST_KEY)));
  rig.shutdown();
});

test("`listening…` shows only once the microphone delivers audio; a release before that still ends the take", async () => {
  const rig = makeRig();
  mic.silent = true; // open, but nothing delivered yet
  await rig.hold();
  await tick();
  assert.match(rig.indicator(), /starting…$/);
  rig.recorder().opts.onChunk({ samples: new Float32Array(800) });
  assert.match(rig.indicator(), /listening…$/);
  rig.shutdown();

  const silent = makeRig();
  mic.silent = true;
  await silent.hold();
  await tick();
  silent.socket().open();
  silent.release();
  await tick();
  assert.match(silent.indicator(), /transcribing…$/);
  silent.socket().final("", { from_finalize: true });
  await sleep(20);
  assert.equal(silent.indicator(), "");
  assert.ok(silent.recorder().stopped && silent.recorder().closed);
  silent.shutdown();
});

test("overlay up: Space passes through and nothing starts", async () => {
  const rig = makeRig();
  rig.overlay = true;
  rig.feed("\x1b[97;1:3u");
  assert.equal(rig.feed(" "), "passed");
  await sleep(400);
  assert.equal(FakeSocket.instances.length, 0);
});

test("a Space released with Shift down, then a capital: nothing deleted, nothing records", async () => {
  const rig = makeRig();
  rig.feed("\x1b[97;1:3u");
  for (const ch of "end.") rig.feed(ch);
  rig.feed(" ");
  rig.feed("\x1b[32;2:3u");
  rig.feed("I");
  await sleep(400);
  assert.equal(rig.text(), "end. I");
  assert.equal(FakeSocket.instances.length, 0);
});

test("typing on with Space still down: `ab xy`, no recording", async () => {
  const rig = makeRig();
  rig.feed("\x1b[97;1:3u");
  for (const ch of ["a", "b", " ", "x", "y"]) rig.feed(ch);
  await sleep(400);
  assert.equal(rig.text(), "ab xy");
  assert.equal(FakeSocket.instances.length, 0);
});

// ---------------------------------------------------------------- typing during a take

test("a key typed while `transcribing…` waits for the final and lands behind it", async () => {
  const rig = await startTake();
  const s = rig.socket();
  s.interim("so that we can measure how quickly Internet");
  rig.release();
  assert.equal(rig.feed("x"), "consumed");
  await tick();
  assert.equal(rig.text(), "so that we can measure how quickly Internet", "held back");
  s.final("So that we can measure how quickly interim words show up.", { from_finalize: true });
  await sleep(20);
  assert.equal(rig.text(), "So that we can measure how quickly interim words show up.x");
  rig.shutdown();
});

test("Enter while `transcribing…` submits the whole text as one prompt", async () => {
  const rig = await startTake();
  const s = rig.socket();
  const submitted: string[] = [];
  rig.editor.onSubmit = (t: string) => submitted.push(t);
  s.interim("run the tests");
  rig.release();
  rig.feed(ENTER);
  await tick();
  s.final("Run the tests.", { from_finalize: true });
  await sleep(20);
  assert.deepEqual(submitted, ["Run the tests."]);
  assert.equal(rig.text(), "");
  rig.shutdown();
});

test("moving the cursor or typing mid-take neither duplicates nor loses text", async () => {
  const rig = makeRig();
  rig.editor.setText("ab");
  await startTake(rig);
  const s = rig.socket();
  s.interim("this is a longer streaming voice test");
  rig.feed("\x1b[D"); // left arrow: the interim steps aside, the cursor moves inside "ab"
  assert.equal(rig.text(), "ab");
  s.interim("this is a longer streaming voice test for");
  rig.feed("z");
  s.final("This is a longer streaming voice test for Pi.");
  await finishNormally(rig);
  assert.equal(rig.text(), "az This is a longer streaming voice test for Pi.b");
  rig.shutdown();
});

test("a Space typed while `transcribing…` that turns into a hold is not left behind", async () => {
  const rig = await startTake();
  const first = rig.socket();
  first.interim("one");
  rig.release(); // transcribing…
  rig.feed(" "); // held back with the other keys
  await sleep(150);
  rig.feed(" "); // … and its first repeat made it a hold
  first.final("One.", { from_finalize: true });
  await sleep(30);
  assert.equal(rig.text(), "One.");
  assert.equal(FakeSocket.instances.length, 2, "the second hold started once the first take settled");
  assert.match(rig.indicator(), /listening/);
  rig.socket().open();
  rig.socket().final("Two.");
  await finishNormally(rig);
  assert.equal(rig.text(), "One. Two.");
  rig.shutdown();
});

test("a second hold released before the first take settled starts nothing", async () => {
  const rig = await startTake();
  rig.release();
  rig.feed(" ");
  await sleep(150);
  rig.feed(" ");
  rig.release();
  rig.socket().final("", { from_finalize: true });
  await sleep(30);
  assert.equal(FakeSocket.instances.length, 1);
  assert.equal(rig.indicator(), "");
  rig.shutdown();
});

test("a take settles on the finalized result, not on the server closing the socket", async () => {
  const rig = await startTake();
  FakeSocket.autoClose = false;
  rig.release();
  await tick();
  rig.socket().final("Done.", { from_finalize: true });
  await sleep(20);
  assert.equal(rig.indicator(), "");
  assert.equal(rig.text(), "Done.");
  rig.shutdown();
});

// ---------------------------------------------------------------- errors

test("network drop mid-take: one error, interim text kept, mic released, next hold works", async () => {
  const rig = await startTake();
  const s = rig.socket();
  s.final("First sentence.");
  s.interim("second sen");
  s.serverClose(1006, "");
  await sleep(20);
  assert.deepEqual(rig.notifications, [{ message: "Lost connection to Deepgram (kept the text transcribed so far)", type: "error" }]);
  assert.equal(rig.text(), "First sentence. second sen");
  assert.equal(rig.indicator(), "");
  assert.ok(rig.recorder().stopped && rig.recorder().closed);
  assert.equal(rig.feed(" "), "consumed"); // the rest of the hold is swallowed
  rig.release();
  await rig.hold();
  await tick();
  assert.equal(FakeSocket.instances.length, 2);
  rig.shutdown();
});

test("a connection that never opens points at the key", async () => {
  const rig = makeRig();
  await rig.hold();
  await tick();
  rig.socket().serverClose(1006, "");
  await sleep(20);
  assert.deepEqual(rig.notifications.map((n) => n.message), ["Could not connect to Deepgram: check DEEPGRAM_API_KEY and your network"]);
  assert.equal(rig.indicator(), "");
  assert.ok(rig.recorder().stopped);
  rig.shutdown();
});

test("mic permission denied: clear message, no stuck state", async () => {
  const rig = makeRig();
  mic.permission = "denied";
  await rig.hold();
  await sleep(20);
  assert.match(rig.notifications[0]?.message ?? "", /Microphone access denied/);
  assert.equal(rig.indicator(), "");
  rig.shutdown();
});

test("finalize timeout: the take ends after 3 s and says the last words may be missing", async () => {
  const rig = await startTake();
  FakeSocket.autoClose = false;
  rig.socket().interim("words still interim");
  rig.release();
  const t0 = Date.now();
  while (rig.indicator() && Date.now() - t0 < 6000) await sleep(50);
  const took = Date.now() - t0;
  assert.ok(took > 2800 && took < 3600, `transcribing… lasted ${took} ms`);
  assert.equal(rig.text(), "words still interim");
  assert.deepEqual(rig.notifications, [{ message: "Deepgram did not answer in time: the last words may be missing.", type: "warning" }]);
  assert.ok(rig.recorder().stopped);
  rig.shutdown();
});

test("shutdown mid-take: mic released, socket closed, no timers left", async () => {
  const before = activeTimers();
  const rig = await startTake();
  rig.socket().interim("hello");
  rig.shutdown();
  await sleep(30);
  assert.ok(rig.recorder().stopped && rig.recorder().closed);
  assert.deepEqual(rig.socket().closeCalls, [1000]);
  assert.equal(activeTimers(), before);
});

test("a finished take leaves no timers behind", async () => {
  const before = activeTimers();
  const rig = await startTake();
  await finishNormally(rig);
  await sleep(30);
  assert.equal(activeTimers(), before);
});

// ---------------------------------------------------------------- /voice

test("/voice off while the mic is still opening releases the mic", async () => {
  const rig = makeRig();
  let open!: () => void;
  mic.gate = new Promise<void>((r) => (open = r));
  await rig.hold();
  await rig.command();
  rig.socket().open();
  open();
  await sleep(30);
  rig.socket().final("", { from_finalize: true });
  await sleep(30);
  const r = rig.recorder();
  assert.ok(r.stopped && r.closed, "microphone left open");
  assert.equal(rig.indicator(), "");
  rig.shutdown();
});

test("/voice with no key says how to set it, whichever way the toggle goes", async () => {
  const rig = makeRig();
  const saved = process.env.DEEPGRAM_API_KEY;
  delete process.env.DEEPGRAM_API_KEY;
  try {
    rig.feed("\x1b[97;1:3u");
    for (let i = 0; i < 5; i += 1) assert.equal(rig.feed(" "), "passed");
    await sleep(400);
    assert.equal(rig.text(), "     ");
    await rig.command();
    assert.match(rig.notifications.at(-1)?.message ?? "", /^Streaming voice off, but DEEPGRAM_API_KEY is not set\..*set -Ux DEEPGRAM_API_KEY/);
    await rig.command();
    assert.match(rig.notifications.at(-1)?.message ?? "", /^Streaming voice on, but DEEPGRAM_API_KEY is not set\..*set -Ux DEEPGRAM_API_KEY/);
  } finally {
    process.env.DEEPGRAM_API_KEY = saved;
  }
});

test("/voice toggles and persists, keeping the other settings", async () => {
  const rig = makeRig();
  await rig.command();
  assert.deepEqual(rig.savedSettings(), { enabled: false, hotkey: "space", mode: "hold", region: "auto" });
  assert.equal(rig.notifications.at(-1)?.message, "Streaming voice off");
  await rig.command();
  assert.equal(rig.notifications.at(-1)?.message, "Streaming voice on: hold space to talk, release to stop");
});

// ---------------------------------------------------------------- /voice-settings

test("/voice-settings shows the four rows and saves a captured hotkey", async () => {
  const rig = makeRig();
  const closed = rig.command("voice-settings");
  for (const row of [/Voice\s+on/, /Hotkey\s+space/, /Mode\s+hold/, /Region\s+Auto$/m]) assert.match(rig.screen(), row);
  rig.feed(DOWN);
  rig.feed(ENTER);
  assert.match(rig.screen(), /Press the key you want/);
  rig.feed("k");
  assert.match(rig.screen(), /k is a key you type with; use Space or a combo with ctrl, alt or cmd/);
  rig.feed("\x0b"); // ctrl+k
  assert.match(rig.screen(), /ctrl\+k is already used by pi for tui\.editor\.deleteToLineEnd/);
  rig.feed("\x0c"); // ctrl+l, an app binding
  assert.match(rig.screen(), /ctrl\+l is already used by pi for app\.model\.select/);
  rig.feed("\x1b[107;9u"); // super+k
  assert.match(rig.screen(), /Hotkey\s+super\+k/);
  assert.deepEqual(rig.savedSettings(), { enabled: true, hotkey: "super+k", mode: "hold", region: "auto" });
  rig.feed(ESCAPE);
  await closed;
  assert.equal(rig.focused, rig.editor);
  assert.equal(rig.text(), "", "nothing leaked into the editor");
});

test("/voice-settings: Escape in the capture keeps the old key", async () => {
  const rig = makeRig();
  void rig.command("voice-settings");
  rig.feed(DOWN);
  rig.feed(ENTER);
  rig.feed(ESCAPE);
  assert.match(rig.screen(), /Hotkey\s+space/);
  assert.throws(() => rig.savedSettings(), "nothing written");
});

test("/voice-settings: tap on Space asks for a combo; cancelling stays on hold", async () => {
  const rig = makeRig();
  void rig.command("voice-settings");
  rig.feed(DOWN);
  rig.feed(DOWN);
  rig.feed(ENTER);
  assert.match(rig.screen(), /Tap mode needs a combo hotkey/);
  rig.feed(" ");
  assert.match(rig.screen(), /Tap mode needs a combo: a tapped Space has to stay a space/);
  rig.feed(ESCAPE);
  assert.match(rig.screen(), /Hotkey\s+space/);
  assert.match(rig.screen(), /Mode\s+hold/);
  rig.feed(ENTER);
  rig.feed(ALT_V);
  assert.match(rig.screen(), /Hotkey\s+alt\+v/);
  assert.match(rig.screen(), /Mode\s+tap/);
  assert.deepEqual(rig.savedSettings(), { enabled: true, hotkey: "alt+v", mode: "tap", region: "auto" });
  // Going back to Space takes the mode back to hold.
  rig.feed("\x1b[A");
  rig.feed(ENTER);
  rig.feed(" ");
  assert.deepEqual(rig.savedSettings(), { enabled: true, hotkey: "space", mode: "hold", region: "auto" });
  assert.match(rig.screen(), /Mode\s+hold/);
});

test("/voice-settings: the region picks the host of the next take", async () => {
  const rig = makeRig();
  void rig.command("voice-settings");
  for (let i = 0; i < 3; i += 1) rig.feed(DOWN);
  for (let i = 0; i < 4; i += 1) rig.feed(ENTER); // Auto → Global → EU → Australia → India
  assert.match(rig.screen(), /Region\s+India/);
  rig.feed(ESCAPE);
  assert.deepEqual(rig.savedSettings(), { enabled: true, hotkey: "space", mode: "hold", region: "in" });
  await startTake(rig);
  assert.match(rig.socket().url, /^wss:\/\/api\.in\.deepgram\.com\/v1\/listen\?/);
  rig.shutdown();
});

test("auto region: a new session measures in the background, caches the pick and uses it for the next take", async () => {
  const rig = makeRig({ timings: { global: [300, 310, 290], eu: [200, 210, 220], au: [undefined], in: [150, 140, 130] } });
  await sleep(5);
  const saved = rig.savedSettings() as { autoPick: { at: number } };
  assert.deepEqual({ ...saved, autoPick: { ...saved.autoPick, at: 0 } }, { enabled: true, hotkey: "space", mode: "hold", region: "auto", autoPick: { region: "in", ms: 140, at: 0 } });
  void rig.command("voice-settings");
  assert.match(rig.screen(), /Region\s+Auto \(India, 140 ms\)/);
  rig.feed(ESCAPE);
  await startTake(rig);
  assert.match(rig.socket().url, /^wss:\/\/api\.in\.deepgram\.com\/v1\/listen\?/);
  rig.shutdown();
});

test("auto region: the cached pick is used from the start; before any measurement, Global", async () => {
  const cached = makeRig({ settings: { region: "auto", autoPick: { region: "eu", ms: 90 } } });
  await startTake(cached);
  assert.match(cached.socket().url, /^wss:\/\/api\.eu\.deepgram\.com\//);
  cached.shutdown();
  const fresh = makeRig();
  await startTake(fresh);
  assert.match(fresh.socket().url, /^wss:\/\/api\.deepgram\.com\//);
  fresh.shutdown();
});

test("auto region: a measurement where every host failed keeps the cached pick", async () => {
  const rig = makeRig({ settings: { region: "auto", autoPick: { region: "in", ms: 140 } }, timings: { global: [undefined], eu: [undefined], au: [undefined], in: [undefined] } });
  await sleep(5);
  assert.deepEqual(rig.savedSettings(), { region: "auto", autoPick: { region: "in", ms: 140 } });
  await startTake(rig);
  assert.match(rig.socket().url, /^wss:\/\/api\.in\.deepgram\.com\//);
  rig.shutdown();
});

test("auto region: a fixed region is not measured, and choosing Auto in the menu measures", async () => {
  const rig = makeRig({ settings: { region: "eu" }, timings: { global: [50, 50, 50] } });
  await sleep(5);
  assert.deepEqual(rig.savedSettings(), { region: "eu" }, "nothing measured, nothing written");
  void rig.command("voice-settings");
  for (let i = 0; i < 3; i += 1) rig.feed(DOWN);
  for (let i = 0; i < 4; i += 1) rig.feed(ENTER); // EU → Australia → India → Auto → Global: passing through Auto starts a measurement
  await sleep(5);
  assert.deepEqual(rig.savedSettings(), { enabled: true, hotkey: "space", mode: "hold", region: "global" }, "a measurement that lands on a fixed region is dropped");
  for (let i = 0; i < 4; i += 1) rig.feed(ENTER); // → EU → Australia → India → Auto
  assert.match(rig.screen(), /Region\s+Auto$/m);
  await sleep(5);
  assert.match(rig.screen(), /Region\s+Auto \(Global, 50 ms\)/);
  const saved = rig.savedSettings() as { autoPick: { at: number } };
  assert.deepEqual({ ...saved, autoPick: { ...saved.autoPick, at: 0 } }, { enabled: true, hotkey: "space", mode: "hold", region: "auto", autoPick: { region: "global", ms: 50, at: 0 } });
  rig.shutdown();
});

const HOUR = 3_600_000;
const ALL_FAILED: Timings = { global: [undefined], eu: [undefined], au: [undefined], in: [undefined] };
const INDIA: Timings = { global: [300, 310, 290], in: [150, 140, 130] };

test("auto region: a pick less than a day old is not measured again, at session start or when voice is turned on", async () => {
  const rig = makeRig({ settings: { region: "auto", autoPick: { region: "eu", ms: 90, at: Date.now() - 23 * HOUR } }, timings: INDIA });
  const before = readFileSync(rig.settingsFile, "utf8");
  await sleep(5);
  assert.equal(rig.probes.length, 0);
  assert.equal(readFileSync(rig.settingsFile, "utf8"), before, "the file is untouched");
  await rig.command(); // off
  await rig.command(); // on
  await sleep(5);
  assert.equal(rig.probes.length, 0);
  await startTake(rig);
  assert.match(rig.socket().url, /^wss:\/\/api\.eu\.deepgram\.com\//);
  rig.shutdown();
});

test("auto region: a pick older than a day, or with no time, is measured again", async () => {
  for (const at of [Date.now() - 25 * HOUR, undefined]) {
    const rig = makeRig({ settings: { region: "auto", autoPick: { region: "eu", ms: 90, at } }, timings: INDIA });
    const started = Date.now();
    await sleep(5);
    assert.equal(rig.probes.length, 1);
    const saved = rig.savedSettings() as { autoPick: { region: string; ms: number; at: number } };
    assert.deepEqual({ ...saved.autoPick, at: 0 }, { region: "in", ms: 140, at: 0 });
    assert.ok(saved.autoPick.at >= started && saved.autoPick.at <= Date.now());
    rig.shutdown();
  }
});

test("auto region: voice turned on with a stale pick measures", async () => {
  const rig = makeRig({ settings: { enabled: false, region: "auto", autoPick: { region: "eu", ms: 90, at: Date.now() - 25 * HOUR } }, timings: INDIA });
  await sleep(5);
  assert.equal(rig.probes.length, 0, "voice is off");
  await rig.command();
  await sleep(5);
  assert.equal(rig.probes.length, 1);
  assert.equal((rig.savedSettings() as { autoPick: { region: string } }).autoPick.region, "in");
  rig.shutdown();
});

test("auto region: choosing Auto in the menu measures even with a fresh pick", async () => {
  const rig = makeRig({ settings: { region: "in", autoPick: { region: "eu", ms: 90, at: Date.now() - HOUR } }, timings: INDIA });
  await sleep(5);
  assert.equal(rig.probes.length, 0);
  void rig.command("voice-settings");
  for (let i = 0; i < 3; i += 1) rig.feed(DOWN);
  rig.feed(ENTER); // India → Auto
  await sleep(5);
  assert.equal(rig.probes.length, 1);
  assert.match(rig.screen(), /Region\s+Auto \(India, 140 ms\)/);
  rig.shutdown();
});

test("auto region: a measurement where every host failed keeps the pick and its time, so the next session tries again", async () => {
  const at = Date.now() - 25 * HOUR;
  const rig = makeRig({ settings: { region: "auto", autoPick: { region: "in", ms: 140, at } }, timings: ALL_FAILED });
  const before = readFileSync(rig.settingsFile, "utf8");
  await sleep(5);
  assert.equal(rig.probes.length, 1);
  assert.equal(readFileSync(rig.settingsFile, "utf8"), before);
  rig.shutdown();
  // With no pick at all, Global is shown, without a time: still stale.
  const none = makeRig({ timings: ALL_FAILED });
  await sleep(5);
  assert.deepEqual((none.savedSettings() as { autoPick: unknown }).autoPick, { region: "global" });
  none.shutdown();
});

test("auto region: a result changes only the pick in a settings file that changed while measuring", async () => {
  let answer!: (timings: Timings) => void;
  const rig = makeRig({ timings: new Promise<Timings>((resolve) => (answer = resolve)) });
  await sleep(5);
  assert.equal(rig.probes.length, 1);
  // Another pi (or this one before /reload) changed the hotkey and mode meanwhile.
  writeFileSync(rig.settingsFile, JSON.stringify({ enabled: false, hotkey: "alt+v", mode: "tap", region: "auto" }));
  answer(INDIA);
  await sleep(5);
  const saved = rig.savedSettings() as { autoPick: { at: number } };
  assert.deepEqual({ ...saved, autoPick: { ...saved.autoPick, at: 0 } }, { enabled: false, hotkey: "alt+v", mode: "tap", region: "auto", autoPick: { region: "in", ms: 140, at: 0 } });
  rig.shutdown();
});

test("auto region: a result is not written to a settings file that changed to a fixed region while measuring", async () => {
  let answer!: (timings: Timings) => void;
  const rig = makeRig({ timings: new Promise<Timings>((resolve) => (answer = resolve)) });
  await sleep(5);
  const other = JSON.stringify({ enabled: true, hotkey: "alt+v", mode: "hold", region: "eu" });
  writeFileSync(rig.settingsFile, other);
  answer(INDIA);
  await sleep(5);
  assert.equal(readFileSync(rig.settingsFile, "utf8"), other);
  rig.shutdown();
});

test("auto region: shutdown aborts the measurement and its late result is dropped", async () => {
  let answer!: (timings: Timings) => void;
  const rig = makeRig({ settings: { region: "auto", hotkey: "alt+v" }, timings: new Promise<Timings>((resolve) => (answer = resolve)) });
  const before = readFileSync(rig.settingsFile, "utf8");
  await sleep(5);
  assert.equal(rig.probes[0]?.aborted, false);
  rig.shutdown();
  assert.equal(rig.probes[0]?.aborted, true);
  answer(INDIA);
  await sleep(5);
  assert.equal(readFileSync(rig.settingsFile, "utf8"), before);
});

// ---------------------------------------------------------------- editor render

test("shutdown takes our render wrapper off the editor, but leaves a wrapper someone else put on top", async () => {
  const plain = makeRig();
  await finishNormally(await startTake(plain));
  assert.ok(Object.hasOwn(plain.editor, "render"), "decorated by the take");
  plain.shutdown();
  assert.ok(!Object.hasOwn(plain.editor, "render"), "back to the editor's own render");

  const rig = makeRig();
  await finishNormally(await startTake(rig));
  const ours = rig.editor.render;
  const theirs = (width: number): string[] => ours(width);
  rig.editor.render = theirs;
  rig.shutdown();
  assert.equal(rig.editor.render, theirs);
  assert.deepEqual(rig.editor.render(40), Object.getPrototypeOf(rig.editor).render.call(rig.editor, 40), "ours is inert without a take");
});

// ---------------------------------------------------------------- combo hotkey

test("alt+v hold: records while down, types nothing, Space is an ordinary key again", async () => {
  const rig = makeRig();
  await useAltV(rig);
  assert.equal(rig.feed(ALT_V), "consumed");
  await tick();
  assert.match(rig.indicator(), /listening…$/);
  const s = rig.socket();
  s.open();
  s.interim("hello");
  assert.equal(rig.feed(ALT_V_RELEASE), "consumed");
  await tick();
  s.final("Hello.", { from_finalize: true });
  await sleep(20);
  assert.equal(rig.text(), "Hello.");
  assert.equal(rig.indicator(), "");
  for (let i = 0; i < 6; i += 1) rig.feed(" ");
  await sleep(400);
  assert.equal(rig.text(), "Hello.      ");
  assert.equal(FakeSocket.instances.length, 1);
  rig.shutdown();
});

test("alt+v tap: press starts, typing goes on, a second press stops", async () => {
  const rig = makeRig();
  await useAltV(rig, "tap");
  rig.feed(ALT_V);
  rig.feed(ALT_V_RELEASE);
  await tick();
  assert.match(rig.indicator(), /listening…$/);
  const s = rig.socket();
  s.open();
  s.interim("hello wor");
  rig.feed("x"); // the interim steps aside for the key
  assert.equal(rig.text(), "x");
  s.final("Hello world.");
  assert.equal(rig.text(), "x Hello world.");
  rig.feed(ALT_V);
  await tick();
  assert.match(rig.indicator(), /transcribing…$/);
  s.final("", { from_finalize: true });
  await sleep(20);
  assert.equal(rig.indicator(), "");
  assert.ok(rig.recorder().stopped);
  rig.shutdown();
});

test("alt+v tap: Escape stops the take and goes no further", async () => {
  const rig = makeRig();
  await useAltV(rig, "tap");
  rig.feed(ALT_V);
  await tick();
  rig.socket().open();
  assert.equal(rig.feed("\x1b[27u"), "consumed");
  await tick();
  assert.match(rig.indicator(), /transcribing…$/);
  rig.shutdown();
});

test("alt+v tap: a dialog taking the focus ends the take", async () => {
  const rig = makeRig();
  await useAltV(rig, "tap");
  rig.feed(ALT_V);
  await tick();
  rig.socket().open();
  rig.overlay = true;
  assert.equal(rig.feed("j"), "passed");
  await tick();
  assert.match(rig.indicator(), /transcribing…$/);
  rig.shutdown();
});

test("no release events: an alt+v hold works as tap, with one notice", async () => {
  const rig = makeRig();
  await useAltV(rig); // captured while kitty was on
  const { setKittyProtocolActive } = await import("@earendil-works/pi-tui");
  setKittyProtocolActive(false);
  rig.feed("\x1bv");
  await tick();
  assert.match(rig.indicator(), /listening…$/);
  assert.deepEqual(rig.notifications.map((n) => n.message), [
    "This terminal does not report key releases, so alt+v works as tap: press it again or Escape to stop.",
  ]);
  rig.socket().open();
  rig.feed("\x1bv");
  await tick();
  rig.socket().final("", { from_finalize: true });
  await sleep(20);
  rig.feed("\x1bv");
  await tick();
  assert.equal(rig.notifications.length, 1, "said once");
  rig.shutdown();
});
