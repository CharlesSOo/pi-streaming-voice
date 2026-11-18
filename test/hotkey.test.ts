import { test } from "node:test";
import assert from "node:assert/strict";
import { TUI_KEYBINDINGS } from "@earendil-works/pi-tui";
import { checkHotkey, classifyHotkey, splitKeyId } from "../src/hotkey.ts";

const BINDINGS: Record<string, string | string[]> = {
  ...Object.fromEntries(Object.entries(TUI_KEYBINDINGS).map(([id, def]) => [id, [def.defaultKeys].flat()])),
  "app.model.select": "ctrl+l",
  "app.model.cycleBackward": "shift+ctrl+p",
  "app.message.followUp": "alt+enter",
};

test("splitKeyId", () => {
  assert.deepEqual(splitKeyId("space"), { base: "space", mods: [] });
  assert.deepEqual(splitKeyId("shift+ctrl+P"), { base: "p", mods: ["ctrl", "shift"] });
  assert.deepEqual(splitKeyId("ctrl++"), { base: "+", mods: ["ctrl"] });
  assert.deepEqual(splitKeyId("+"), { base: "+", mods: [] });
  assert.deepEqual(splitKeyId("esc"), { base: "escape", mods: [] });
});

test("classifyHotkey: Space", () => {
  const space = splitKeyId("space");
  assert.equal(classifyHotkey(" ", space), "press");
  assert.equal(classifyHotkey("\x1b[32u", space), "press");
  assert.equal(classifyHotkey("\x1b[32;1:1u", space), "press");
  assert.equal(classifyHotkey("\x1b[32;65u", space), "press"); // caps lock on
  assert.equal(classifyHotkey("\x1b[32;1:2u", space), "repeat");
  assert.equal(classifyHotkey("\x1b[32;1:3u", space), "release");
  assert.equal(classifyHotkey("\x1b[32;2:3u", space), "release"); // shift down at release
  assert.equal(classifyHotkey("\x1b[32;65:3u", space), "release"); // caps lock on
  assert.equal(classifyHotkey("\x1b[32;5u", space), undefined); // ctrl+space
  assert.equal(classifyHotkey("a", space), undefined);
  assert.equal(classifyHotkey("  ", space), undefined);
  assert.equal(classifyHotkey("\x1b[200~ \x1b[201~", space), undefined); // pasted space
});

test("classifyHotkey: combos", () => {
  const altV = splitKeyId("alt+v");
  assert.equal(classifyHotkey("\x1b[118;3u", altV), "press");
  assert.equal(classifyHotkey("\x1b[118;3:2u", altV), "repeat");
  assert.equal(classifyHotkey("\x1b[118;3:3u", altV), "release");
  assert.equal(classifyHotkey("\x1b[118;1:3u", altV), "release"); // alt came up first
  assert.equal(classifyHotkey("v", altV), undefined);
  assert.equal(classifyHotkey("\x1b[118;7u", altV), undefined); // ctrl+alt+v
  assert.equal(classifyHotkey("\x1bv", altV), "press"); // legacy terminals
  const superK = splitKeyId("super+k");
  assert.equal(classifyHotkey("\x1b[107;9u", superK), "press");
  assert.equal(classifyHotkey("\x1b[107;9:3u", superK), "release");
  assert.equal(classifyHotkey("\x1b[32;5u", splitKeyId("ctrl+space")), "press");
});

test("checkHotkey accepts Space and free combos", () => {
  for (const id of ["space", "super+k", "alt+v", "ctrl+space", "ctrl+alt+v", "shift+super+k", "alt+f5", "ctrl+."]) {
    assert.deepEqual(checkHotkey(id, BINDINGS), { ok: true, hotkey: splitKeyId(id).mods.concat(splitKeyId(id).base).join("+") }, id);
  }
});

test("checkHotkey rejects keys you type with, and says why", () => {
  for (const id of ["a", "7", ".", "shift+a", "f5", "up", "shift+space"]) {
    const check = checkHotkey(id, BINDINGS);
    assert.equal(check.ok, false, id);
    assert.match((check as { reason: string }).reason, /ctrl, alt or cmd/, id);
  }
  for (const [id, why] of [["enter", /Enter submits/], ["escape", /Escape cancels/], ["tab", /Tab completes/], ["backspace", /Backspace deletes/]] as const) {
    const check = checkHotkey(id, BINDINGS);
    assert.equal(check.ok, false, id);
    assert.match((check as { reason: string }).reason, why, id);
  }
  assert.deepEqual(checkHotkey(undefined, BINDINGS), { ok: false, reason: "pi does not recognise that key" });
});

test("checkHotkey rejects keys pi binds and names the action", () => {
  for (const [id, action] of [
    ["ctrl+k", "tui.editor.deleteToLineEnd"],
    ["ctrl+c", "tui.input.copy, tui.select.cancel"],
    ["alt+b", "tui.editor.cursorWordLeft"],
    ["ctrl+l", "app.model.select"],
    ["ctrl+shift+p", "app.model.cycleBackward"], // modifier order does not matter
    ["alt+enter", "app.message.followUp"],
  ] as const) {
    assert.deepEqual(checkHotkey(id, BINDINGS), { ok: false, reason: `${splitKeyId(id).mods.concat(splitKeyId(id).base).join("+")} is already used by pi for ${action}` }, id);
  }
});

test("classifyHotkey: lock bits on a combo press are ignored; extra real modifiers are not", () => {
  const altV = splitKeyId("alt+v");
  assert.equal(classifyHotkey("\x1b[118;67u", altV), "press"); // alt + caps_lock
  assert.equal(classifyHotkey("\x1b[118;131u", altV), "press"); // alt + num_lock
  assert.equal(classifyHotkey("\x1b[118;4u", altV), undefined); // shift+alt+v
  assert.equal(classifyHotkey("\x1b[118;7u", altV), undefined); // ctrl+alt+v
  assert.equal(classifyHotkey("\x1b[118;4:3u", altV), "release"); // released with shift down
  assert.equal(classifyHotkey("\x1b[118;1:3u", altV), "release"); // alt came up first
  assert.equal(classifyHotkey("\x1bv", altV), "press"); // legacy alt+v
});

test("classifyHotkey: Space with other modifiers", () => {
  const space = splitKeyId("space");
  assert.equal(classifyHotkey("\x1b[32;2u", space), undefined); // shift+space encoded is not the hotkey press
  assert.equal(classifyHotkey("\x1b[32;5:3u", space), "release"); // any Space release counts
});

test("checkHotkey against pi's real default bindings", async () => {
  const { KEYBINDINGS } = await import("../node_modules/@earendil-works/pi-coding-agent/dist/core/keybindings.js");
  const { KeybindingsManager } = await import("@earendil-works/pi-tui");
  const bindings = new KeybindingsManager({ ...TUI_KEYBINDINGS, ...KEYBINDINGS }).getResolvedBindings();
  for (const key of ["ctrl+c", "ctrl+d", "ctrl+z", "escape", "enter", "tab", "backspace", "a", "shift+a", "1", "/", "f5", "up", "shift+enter", "shift+tab", "alt+enter", "ctrl+k", "ctrl+l"]) {
    assert.equal(checkHotkey(key, bindings).ok, false, `${key} should be refused`);
  }
  for (const key of ["space", "alt+v", "ctrl+space", "super+k", "super+j", "alt+shift+v"]) {
    assert.equal(checkHotkey(key, bindings).ok, true, `${key} should be allowed`);
  }
  assert.equal(checkHotkey(undefined, bindings).ok, false);
});
