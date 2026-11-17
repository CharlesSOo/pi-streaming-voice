import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";

export const SETTINGS_FILENAME = "pi-streaming-voice.json";

export interface VoiceSettings {
  enabled: boolean;
}

export const DEFAULT_SETTINGS: VoiceSettings = { enabled: true };

export function settingsPath(agentDir: string): string {
  return join(agentDir, SETTINGS_FILENAME);
}

export function loadSettings(path: string): VoiceSettings {
  try {
    const parsed = JSON.parse(readFileSync(path, "utf8")) as Partial<VoiceSettings>;
    return { enabled: typeof parsed.enabled === "boolean" ? parsed.enabled : DEFAULT_SETTINGS.enabled };
  } catch {
    return { ...DEFAULT_SETTINGS };
  }
}

export function saveSettings(path: string, settings: VoiceSettings): void {
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, `${JSON.stringify(settings, null, 2)}\n`);
}
