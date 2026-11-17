/** The `/voice-settings` menu: Voice on/off, Hotkey, Mode, Region. */
import type { Theme } from "@earendil-works/pi-coding-agent";
import {
  matchesKey,
  parseKey,
  SettingsList,
  truncateToWidth,
  type Component,
  type KeybindingsManager,
  type SettingItem,
  type TUI,
} from "@earendil-works/pi-tui";
import type { Region } from "./deepgram.ts";
import { checkHotkey, DEFAULT_HOTKEY, type VoiceMode } from "./hotkey.ts";
import type { VoiceSettings } from "./settings.ts";

export interface SettingsHost {
  current(): VoiceSettings;
  update(patch: Partial<VoiceSettings>): void;
}

const REGION_LABELS: Record<Region, string> = { global: "Global", eu: "EU", au: "Australia", in: "India" };

/** "Press the key you want": resolves with a valid hotkey, or undefined when cancelled with Escape. */
function captureHotkey(
  theme: Theme,
  keybindings: KeybindingsManager,
  opts: { title: string; comboOnly: boolean },
  finish: (hotkey: string | undefined) => void,
): Component {
  let problem = "";
  return {
    render(width: number): string[] {
      const lines = [
        theme.fg("accent", opts.title),
        theme.fg("dim", `${opts.comboOnly ? "A combo" : "Space, or a combo"} with ctrl, alt or cmd, e.g. alt+v. Escape cancels.`),
      ];
      if (problem) lines.push(theme.fg("warning", problem));
      return lines.map((line) => truncateToWidth(line, width));
    },
    handleInput(data: string): void {
      if (matchesKey(data, "escape")) {
        finish(undefined);
        return;
      }
      const check = checkHotkey(parseKey(data), keybindings.getResolvedBindings());
      if (!check.ok) problem = check.reason;
      else if (opts.comboOnly && check.hotkey === DEFAULT_HOTKEY) problem = "Tap mode needs a combo: a tapped Space has to stay a space";
      else finish(check.hotkey);
    },
    invalidate() {},
  };
}

export function createSettingsMenu(
  tui: TUI,
  theme: Theme,
  keybindings: KeybindingsManager,
  host: SettingsHost,
  done: () => void,
): Component {
  const settings = host.current();
  /** Hotkey capture opened by choosing tap while the hotkey is Space. */
  let capture: Component | undefined;

  const items: SettingItem[] = [
    { id: "enabled", label: "Voice", currentValue: settings.enabled ? "on" : "off", values: ["on", "off"] },
    {
      id: "hotkey",
      label: "Hotkey",
      description: "The key that starts voice input: Space, or a combo with ctrl, alt or cmd",
      currentValue: settings.hotkey,
      submenu: (_current, close) => captureHotkey(theme, keybindings, { title: "Press the key you want", comboOnly: false }, close),
    },
    {
      id: "mode",
      label: "Mode",
      description: "hold: talk while the key is down. tap: press to start, press again or Escape to stop (needs a combo hotkey)",
      currentValue: settings.mode,
      values: ["hold", "tap"],
    },
    {
      id: "region",
      label: "Region",
      description: "Deepgram host for the next take. A nearer one answers sooner; regional hosts process in-region only",
      currentValue: REGION_LABELS[settings.region],
      values: Object.values(REGION_LABELS),
    },
  ];

  const list = new SettingsList(
    items,
    items.length + 2,
    {
      label: (text, selected) => (selected ? theme.fg("accent", text) : text),
      value: (text, selected) => (selected ? theme.fg("accent", text) : theme.fg("muted", text)),
      description: (text) => theme.fg("dim", text),
      cursor: theme.fg("accent", "→ "),
      hint: (text) => theme.fg("dim", text),
    },
    (id, value) => {
      if (id === "enabled") {
        host.update({ enabled: value === "on" });
      } else if (id === "hotkey") {
        if (value === DEFAULT_HOTKEY && host.current().mode === "tap") {
          host.update({ hotkey: value, mode: "hold" });
          list.updateValue("mode", "hold");
        } else {
          host.update({ hotkey: value });
        }
      } else if (id === "region") {
        const region = (Object.keys(REGION_LABELS) as Region[]).find((r) => REGION_LABELS[r] === value);
        if (region) host.update({ region });
      } else if (id === "mode") {
        if (value === "tap" && host.current().hotkey === DEFAULT_HOTKEY) {
          // Tap needs a combo: ask for one, and stay on hold if that is cancelled.
          list.updateValue("mode", "hold");
          capture = captureHotkey(theme, keybindings, { title: "Tap mode needs a combo hotkey: press the key you want", comboOnly: true }, (hotkey) => {
            capture = undefined;
            if (!hotkey) return;
            host.update({ hotkey, mode: "tap" });
            list.updateValue("hotkey", hotkey);
            list.updateValue("mode", "tap");
          });
        } else {
          host.update({ mode: value as VoiceMode });
        }
      }
    },
    done,
  );

  return {
    capturesViewportInput: list.capturesViewportInput,
    render(width: number): string[] {
      if (capture) return capture.render(width);
      return [truncateToWidth(theme.fg("accent", theme.bold("Voice settings")), width), "", ...list.render(width)];
    },
    handleInput(data: string): void {
      (capture ?? list).handleInput?.(data);
      tui.requestRender();
    },
    invalidate(): void {
      list.invalidate();
    },
  };
}
