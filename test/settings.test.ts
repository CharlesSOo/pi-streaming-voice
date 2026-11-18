import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DEFAULT_SETTINGS, loadSettings, saveSettings } from "../src/settings.ts";

function fileWith(content: string): string {
  const path = join(mkdtempSync(join(tmpdir(), "psv-settings-")), "pi-streaming-voice.json");
  writeFileSync(path, content);
  return path;
}

test("a settings file that only has `enabled` loads with the default hotkey, mode and region", () => {
  assert.deepEqual(loadSettings(fileWith('{\n  "enabled": false\n}\n')), { enabled: false, hotkey: "space", mode: "hold", region: "auto" });
  assert.deepEqual(loadSettings(fileWith('{"enabled": true}')), { enabled: true, hotkey: "space", mode: "hold", region: "auto" });
});

test("missing or broken file gives the defaults", () => {
  assert.deepEqual(loadSettings(join(tmpdir(), "psv-no-such-dir", "x.json")), DEFAULT_SETTINGS);
  assert.deepEqual(loadSettings(fileWith("not json")), DEFAULT_SETTINGS);
  assert.deepEqual(DEFAULT_SETTINGS, { enabled: true, hotkey: "space", mode: "hold", region: "auto" });
});

test("save then load round-trips {enabled, hotkey, mode}", () => {
  const path = fileWith("{}");
  saveSettings(path, { enabled: true, hotkey: "super+k", mode: "tap", region: "in" });
  assert.deepEqual(JSON.parse(readFileSync(path, "utf8")), { enabled: true, hotkey: "super+k", mode: "tap", region: "in" });
  assert.deepEqual(loadSettings(path), { enabled: true, hotkey: "super+k", mode: "tap", region: "in" });
});

test("a settings file without `region` loads as auto; an unknown region too", () => {
  assert.equal(loadSettings(fileWith('{"enabled": true, "hotkey": "alt+v", "mode": "tap"}')).region, "auto");
  assert.equal(loadSettings(fileWith('{"region": "mars"}')).region, "auto");
  assert.equal(loadSettings(fileWith('{"region": "auto"}')).region, "auto");
  assert.equal(loadSettings(fileWith('{"region": "eu"}')).region, "eu");
});

test("the cached auto pick round-trips; a broken one is dropped", () => {
  const path = fileWith("{}");
  saveSettings(path, { ...DEFAULT_SETTINGS, autoPick: { region: "in", ms: 140 } });
  assert.deepEqual(loadSettings(path), { ...DEFAULT_SETTINGS, autoPick: { region: "in", ms: 140 } });
  saveSettings(path, { ...DEFAULT_SETTINGS, autoPick: { region: "in", ms: 140, at: 1_800_000_000_000 } });
  assert.deepEqual(loadSettings(path), { ...DEFAULT_SETTINGS, autoPick: { region: "in", ms: 140, at: 1_800_000_000_000 } });
  assert.deepEqual(loadSettings(fileWith('{"autoPick": {"region": "in", "ms": 140, "at": "today"}}')), { ...DEFAULT_SETTINGS, autoPick: { region: "in", ms: 140 } });
  assert.deepEqual(loadSettings(fileWith('{"autoPick": {"region": "global"}}')), { ...DEFAULT_SETTINGS, autoPick: { region: "global" } });
  assert.deepEqual(loadSettings(fileWith('{"autoPick": {"region": "mars", "ms": 1}}')), DEFAULT_SETTINGS);
  assert.deepEqual(loadSettings(fileWith('{"autoPick": "in"}')), DEFAULT_SETTINGS);
});

test("a hand-edited file cannot ask for an unusable hotkey or tap on Space", () => {
  assert.deepEqual(loadSettings(fileWith('{"hotkey": "a", "mode": "tap"}')), DEFAULT_SETTINGS);
  assert.deepEqual(loadSettings(fileWith('{"hotkey": "space", "mode": "tap"}')), DEFAULT_SETTINGS);
  assert.deepEqual(loadSettings(fileWith('{"hotkey": "alt+v", "mode": "nonsense"}')), { enabled: true, hotkey: "alt+v", mode: "hold", region: "auto" });
});
