/** The voice hotkey: pi key ids (`space`, `alt+v`, `super+k`), parsed by pi-tui. */
import { isKeyRelease, isKeyRepeat, parseKey } from "@earendil-works/pi-tui";

export const DEFAULT_HOTKEY = "space";

export type VoiceMode = "hold" | "tap";

export interface KeyParts {
  base: string;
  /** Sorted modifier names. */
  mods: string[];
}

const ALIASES: Record<string, string> = { esc: "escape", return: "enter" };

/** Split a pi key id (as returned by `parseKey` or written in keybindings.json) into key and modifiers. */
export function splitKeyId(id: string): KeyParts {
  const lower = id.toLowerCase();
  const plusKey = lower.endsWith("+"); // "+" and "ctrl++"
  const parts = (plusKey ? lower.slice(0, -1) : lower).split("+").filter((p) => p !== "");
  const base = plusKey ? "+" : (parts.pop() ?? "");
  return { base: ALIASES[base] ?? base, mods: parts.sort() };
}

function joinKeyId(key: KeyParts): string {
  return [...key.mods, key.base].join("+");
}

/** A combo carries ctrl, alt or super, so pressing it types nothing. */
export function isCombo(key: KeyParts): boolean {
  return key.mods.some((m) => m === "ctrl" || m === "alt" || m === "super");
}

export type HotkeyEvent = "press" | "repeat" | "release";

/**
 * What `data` means for `hotkey`, or undefined when it is some other key.
 * A press must carry exactly the hotkey's modifiers (lock keys aside); a
 * release counts whatever modifiers are down by then.
 */
export function classifyHotkey(data: string, hotkey: KeyParts): HotkeyEvent | undefined {
  const id = parseKey(data);
  if (id === undefined) return undefined;
  const key = splitKeyId(id);
  if (key.base !== hotkey.base) return undefined;
  if (isKeyRelease(data)) return "release";
  if (key.mods.join("+") !== hotkey.mods.join("+")) return undefined;
  return isKeyRepeat(data) ? "repeat" : "press";
}

export type HotkeyCheck = { ok: true; hotkey: string } | { ok: false; reason: string };

const EDITOR_KEYS: Record<string, string> = {
  enter: "Enter submits the prompt",
  escape: "Escape cancels",
  tab: "Tab completes",
  backspace: "Backspace deletes",
};

/**
 * Whether `id` can be the voice hotkey: Space, or a combo with ctrl, alt or
 * cmd (`super`) that pi does not already use. `bindings` maps pi's action ids
 * to their keys (`KeybindingsManager.getResolvedBindings()`).
 */
export function checkHotkey(id: string | undefined, bindings: Record<string, string | string[] | undefined> = {}): HotkeyCheck {
  if (!id) return { ok: false, reason: "pi does not recognise that key" };
  const key = splitKeyId(id);
  const hotkey = joinKeyId(key);
  if (hotkey === "space") return { ok: true, hotkey };
  if (!isCombo(key)) {
    const why = EDITOR_KEYS[key.base];
    if (why && key.mods.length === 0) return { ok: false, reason: `${why}, so it cannot start voice input` };
    return { ok: false, reason: `${hotkey} is a key you type with; use Space or a combo with ctrl, alt or cmd` };
  }
  const owners = Object.entries(bindings)
    .filter(([, keys]) => [keys ?? []].flat().some((k) => joinKeyId(splitKeyId(k)) === hotkey))
    .map(([action]) => action);
  if (owners.length > 0) return { ok: false, reason: `${hotkey} is already used by pi for ${owners.join(", ")}` };
  return { ok: true, hotkey };
}
