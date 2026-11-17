// The extension end to end, minus network and microphone (see harness.ts).
import assert from "node:assert/strict";
import { test } from "node:test";
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
  assert.deepEqual(rig.widgetLines(), []);
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
  assert.match(rig.widgetLines()[0] ?? "", /listening…$/);
  const s = rig.socket();
  assert.match(s.url, /^wss:\/\/api\.deepgram\.com\/v1\/listen\?/);
  assert.ok(!s.url.includes(TEST_KEY), "key must not be in the URL");
  assert.deepEqual(s.init, { headers: { Authorization: `Token ${TEST_KEY}` } });
  rig.recorder().opts.onChunk({ samples: new Float32Array(800).fill(0.1) });
  assert.equal(s.sent.length, 1);
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
  assert.match(rig.widgetLines()[0] ?? "", /transcribing…$/);
  assert.ok(s.json.some((j) => j.includes("Finalize")));
  s.final("And add tests.", { from_finalize: true });
  await sleep(20);
  assert.equal(rig.text(), "fix The bug in Pi. And add tests.");
  assert.deepEqual(rig.widgetLines(), []);
  assert.ok(rig.recorder().stopped && rig.recorder().closed, "mic released");
  assert.equal(submitted, 0);
  assert.ok(rig.notifications.every((n) => !n.message.includes(TEST_KEY)));
  rig.shutdown();
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

test("typing on with Space still down past the threshold: `ab xy`, no recording", async () => {
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
  await sleep(380); // … and it was a hold
  first.final("One.", { from_finalize: true });
  await sleep(30);
  assert.equal(rig.text(), "One.");
  assert.equal(FakeSocket.instances.length, 2, "the second hold started once the first take settled");
  assert.match(rig.widgetLines()[0] ?? "", /listening/);
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
  await sleep(380);
  rig.release();
  rig.socket().final("", { from_finalize: true });
  await sleep(30);
  assert.equal(FakeSocket.instances.length, 1);
  assert.deepEqual(rig.widgetLines(), []);
  rig.shutdown();
});

test("a take settles on the finalized result, not on the server closing the socket", async () => {
  const rig = await startTake();
  FakeSocket.autoClose = false;
  rig.release();
  await tick();
  rig.socket().final("Done.", { from_finalize: true });
  await sleep(20);
  assert.deepEqual(rig.widgetLines(), []);
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
  assert.deepEqual(rig.widgetLines(), []);
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
  assert.deepEqual(rig.widgetLines(), []);
  assert.ok(rig.recorder().stopped);
  rig.shutdown();
});

test("mic permission denied: clear message, no stuck state", async () => {
  const rig = makeRig();
  mic.permission = "denied";
  await rig.hold();
  await sleep(20);
  assert.match(rig.notifications[0]?.message ?? "", /Microphone access denied/);
  assert.deepEqual(rig.widgetLines(), []);
  rig.shutdown();
});

test("finalize timeout: the take ends after 3 s and says the last words may be missing", async () => {
  const rig = await startTake();
  FakeSocket.autoClose = false;
  rig.socket().interim("words still interim");
  rig.release();
  const t0 = Date.now();
  while (rig.widgetLines().length && Date.now() - t0 < 6000) await sleep(50);
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
  assert.deepEqual(rig.widgetLines(), []);
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
  assert.deepEqual(rig.savedSettings(), { enabled: false, hotkey: "space", mode: "hold", region: "global" });
  assert.equal(rig.notifications.at(-1)?.message, "Streaming voice off");
  await rig.command();
  assert.equal(rig.notifications.at(-1)?.message, "Streaming voice on: hold space to talk, release to stop");
});

// ---------------------------------------------------------------- /voice-settings

test("/voice-settings shows the four rows and saves a captured hotkey", async () => {
  const rig = makeRig();
  const closed = rig.command("voice-settings");
  for (const row of [/Voice\s+on/, /Hotkey\s+space/, /Mode\s+hold/, /Region\s+Global/]) assert.match(rig.screen(), row);
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
  assert.deepEqual(rig.savedSettings(), { enabled: true, hotkey: "super+k", mode: "hold", region: "global" });
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
  assert.deepEqual(rig.savedSettings(), { enabled: true, hotkey: "alt+v", mode: "tap", region: "global" });
  // Going back to Space takes the mode back to hold.
  rig.feed("\x1b[A");
  rig.feed(ENTER);
  rig.feed(" ");
  assert.deepEqual(rig.savedSettings(), { enabled: true, hotkey: "space", mode: "hold", region: "global" });
  assert.match(rig.screen(), /Mode\s+hold/);
});

test("/voice-settings: the region picks the host of the next take", async () => {
  const rig = makeRig();
  void rig.command("voice-settings");
  for (let i = 0; i < 3; i += 1) rig.feed(DOWN);
  for (let i = 0; i < 3; i += 1) rig.feed(ENTER); // Global → EU → Australia → India
  assert.match(rig.screen(), /Region\s+India/);
  rig.feed(ESCAPE);
  assert.deepEqual(rig.savedSettings(), { enabled: true, hotkey: "space", mode: "hold", region: "in" });
  await startTake(rig);
  assert.match(rig.socket().url, /^wss:\/\/api\.in\.deepgram\.com\/v1\/listen\?/);
  rig.shutdown();
});

// ---------------------------------------------------------------- combo hotkey

test("alt+v hold: records while down, types nothing, Space is an ordinary key again", async () => {
  const rig = makeRig();
  await useAltV(rig);
  assert.equal(rig.feed(ALT_V), "consumed");
  await tick();
  assert.match(rig.widgetLines()[0] ?? "", /listening…$/);
  const s = rig.socket();
  s.open();
  s.interim("hello");
  assert.equal(rig.feed(ALT_V_RELEASE), "consumed");
  await tick();
  s.final("Hello.", { from_finalize: true });
  await sleep(20);
  assert.equal(rig.text(), "Hello.");
  assert.deepEqual(rig.widgetLines(), []);
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
  assert.match(rig.widgetLines()[0] ?? "", /listening…$/);
  const s = rig.socket();
  s.open();
  s.interim("hello wor");
  rig.feed("x"); // the interim steps aside for the key
  assert.equal(rig.text(), "x");
  s.final("Hello world.");
  assert.equal(rig.text(), "x Hello world.");
  rig.feed(ALT_V);
  await tick();
  assert.match(rig.widgetLines()[0] ?? "", /transcribing…$/);
  s.final("", { from_finalize: true });
  await sleep(20);
  assert.deepEqual(rig.widgetLines(), []);
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
  assert.match(rig.widgetLines()[0] ?? "", /transcribing…$/);
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
  assert.match(rig.widgetLines()[0] ?? "", /transcribing…$/);
  rig.shutdown();
});

test("no release events: an alt+v hold works as tap, with one notice", async () => {
  const rig = makeRig();
  await useAltV(rig); // captured while kitty was on
  const { setKittyProtocolActive } = await import("@earendil-works/pi-tui");
  setKittyProtocolActive(false);
  rig.feed("\x1bv");
  await tick();
  assert.match(rig.widgetLines()[0] ?? "", /listening…$/);
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
