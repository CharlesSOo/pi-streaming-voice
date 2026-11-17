import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { REGION_HOSTS, type Region } from "./deepgram.ts";
import { checkHotkey, DEFAULT_HOTKEY, type VoiceMode } from "./hotkey.ts";

export const SETTINGS_FILENAME = "pi-streaming-voice.json";

export interface VoiceSettings {
  enabled: boolean;
  /** pi key id: `space`, or a combo such as `alt+v` or `super+k`. */
  hotkey: string;
  mode: VoiceMode;
  /** Which Deepgram host takes connect to. */
  region: Region;
}

export const DEFAULT_SETTINGS: VoiceSettings = { enabled: true, hotkey: DEFAULT_HOTKEY, mode: "hold", region: "global" };

export function settingsPath(agentDir: string): string {
  return join(agentDir, SETTINGS_FILENAME);
}

export function loadSettings(path: string): VoiceSettings {
  try {
    const parsed = JSON.parse(readFileSync(path, "utf8")) as Partial<Record<keyof VoiceSettings, unknown>>;
    const checked = checkHotkey(typeof parsed.hotkey === "string" ? parsed.hotkey : undefined);
    const hotkey = checked.ok ? checked.hotkey : DEFAULT_SETTINGS.hotkey;
    return {
      enabled: typeof parsed.enabled === "boolean" ? parsed.enabled : DEFAULT_SETTINGS.enabled,
      hotkey,
      // Tap needs a combo: a tapped Space has to stay a space.
      mode: parsed.mode === "tap" && hotkey !== DEFAULT_HOTKEY ? "tap" : "hold",
      region: typeof parsed.region === "string" && Object.hasOwn(REGION_HOSTS, parsed.region) ? (parsed.region as Region) : DEFAULT_SETTINGS.region,
    };
  } catch {
    return { ...DEFAULT_SETTINGS };
  }
}

export function saveSettings(path: string, settings: VoiceSettings): void {
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, `${JSON.stringify(settings, null, 2)}\n`);
}
