import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { REGION_HOSTS, type Region } from "./deepgram.ts";
import type { AutoPick } from "./region-probe.ts";
import { checkHotkey, DEFAULT_HOTKEY, type VoiceMode } from "./hotkey.ts";

export const SETTINGS_FILENAME = "pi-streaming-voice.json";

export interface VoiceSettings {
  enabled: boolean;
  /** pi key id: `space`, or a combo such as `alt+v` or `super+k`. */
  hotkey: string;
  mode: VoiceMode;
  /** Which Deepgram host takes connect to; `auto` uses the fastest one measured. */
  region: Region | "auto";
  /** What `auto` last measured as fastest and when, kept so the next sessions start with it. */
  autoPick?: AutoPick;
}

export const DEFAULT_SETTINGS: VoiceSettings = { enabled: true, hotkey: DEFAULT_HOTKEY, mode: "hold", region: "auto" };

export function settingsPath(agentDir: string): string {
  return join(agentDir, SETTINGS_FILENAME);
}

export function loadSettings(path: string): VoiceSettings {
  try {
    const parsed = JSON.parse(readFileSync(path, "utf8")) as Partial<Record<keyof VoiceSettings, unknown>>;
    const checked = checkHotkey(typeof parsed.hotkey === "string" ? parsed.hotkey : undefined);
    const hotkey = checked.ok ? checked.hotkey : DEFAULT_SETTINGS.hotkey;
    const isRegion = (value: unknown): value is Region => typeof value === "string" && Object.hasOwn(REGION_HOSTS, value);
    const pick = parsed.autoPick as { region?: unknown; ms?: unknown; at?: unknown } | null | undefined;
    const num = (value: unknown) => typeof value === "number";
    return {
      enabled: typeof parsed.enabled === "boolean" ? parsed.enabled : DEFAULT_SETTINGS.enabled,
      hotkey,
      // Tap needs a combo: a tapped Space has to stay a space.
      mode: parsed.mode === "tap" && hotkey !== DEFAULT_HOTKEY ? "tap" : "hold",
      region: isRegion(parsed.region) ? parsed.region : DEFAULT_SETTINGS.region,
      ...(pick && isRegion(pick.region) && { autoPick: { region: pick.region, ...(num(pick.ms) && { ms: pick.ms as number }), ...(num(pick.at) && { at: pick.at as number }) } }),
    };
  } catch {
    return { ...DEFAULT_SETTINGS };
  }
}

export function saveSettings(path: string, settings: VoiceSettings): void {
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, `${JSON.stringify(settings, null, 2)}\n`);
}
