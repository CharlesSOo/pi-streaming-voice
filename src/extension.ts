import { getAgentDir, type ExtensionAPI, type ExtensionContext, type Theme } from "@earendil-works/pi-coding-agent";
import {
  isKeyRelease,
  isKittyProtocolActive,
  parseKey,
  sliceByColumn,
  visibleWidth,
  type Component,
  type TUI,
} from "@earendil-works/pi-tui";
import { levelOf, openMicrophone, renderLevel, type Microphone } from "./audio.ts";
import { buildListenUrl, DeepgramStream } from "./deepgram.ts";
import { measureRegions, pickRegion, type MeasureRegions } from "./region-probe.ts";
import { BACKSPACE, HotkeyDetector } from "./hold-detector.ts";
import { loadSettings, saveSettings, settingsPath, type VoiceSettings } from "./settings.ts";
import { createSettingsMenu } from "./settings-menu.ts";
import { planReplace, separatorBefore } from "./text.ts";

export const COMMAND = "voice";
export const SETTINGS_COMMAND = "voice-settings";
const WIDGET_KEY = "pi-streaming-voice";
const KEY_ENV = "DEEPGRAM_API_KEY";
const KEY_HELP = `Set ${KEY_ENV} in your environment, e.g. fish: set -Ux ${KEY_ENV} <your-key>  (bash/zsh: export ${KEY_ENV}=<your-key>), then restart pi.`;

/** The editor surface we use: pi-tui's Editor (and CustomEditor subclasses). */
interface EditorLike {
  handleInput(data: string): void;
  insertTextAtCursor(text: string): void;
  getLines(): string[];
  getCursor(): { line: number; col: number };
  render(width: number): string[];
}

function asEditor(component: unknown): EditorLike | undefined {
  const c = component as Partial<EditorLike> | null | undefined;
  if (
    c &&
    typeof c.insertTextAtCursor === "function" &&
    typeof c.handleInput === "function" &&
    typeof c.getLines === "function" &&
    typeof c.getCursor === "function" &&
    typeof c.render === "function"
  ) {
    return c as EditorLike;
  }
  return undefined;
}

function apiKey(): string | undefined {
  const key = process.env[KEY_ENV]?.trim();
  return key ? key : undefined;
}

type Phase = "connecting" | "listening" | "finishing";

class Take {
  phase: Phase = "connecting";
  /** Unfinalized transcript currently typed in the editor just before the cursor, including its leading separator. */
  shown = "";
  level = 0;
  stopRequested = false;
  mic: Microphone | undefined;
  stream: DeepgramStream | undefined;
  inserted = false;
  /** Over (finished, failed or shut down): nothing more may touch the editor. */
  ended = false;
  /** Keys typed while the final words were still on their way, replayed once those are in place. */
  held: string[] = [];
  repaint: ReturnType<typeof setInterval> | undefined;
  readonly editor: EditorLike;
  constructor(editor: EditorLike) {
    this.editor = editor;
  }
}

/** Keyboard input the editor would act on: not a key release, mouse report or terminal reply. */
function isEditorInput(data: string): boolean {
  if (isKeyRelease(data)) return false;
  if (!data.startsWith("\x1b")) return true;
  return data.startsWith("\x1b[200~") || parseKey(data) !== undefined;
}

/** `measure` is replaced in tests; pi calls this with `pi` only. */
export default function streamingVoice(pi: ExtensionAPI, measure: MeasureRegions = measureRegions): void {
  const path = settingsPath(getAgentDir());
  let settings: VoiceSettings = loadSettings(path);
  let tui: TUI | undefined;
  let theme: Theme | undefined;
  let ctxRef: ExtensionContext | undefined;
  let unsubscribe: (() => void) | undefined;
  let take: Take | undefined;
  /** The hotkey went down again while the previous take was still finishing: start once that has settled. */
  let queued = false;
  let tapNoticeShown = false;
  let measuring = false;

  const detector = new HotkeyDetector({
    now: () => performance.now(),
    setTimer: (fn, ms) => setTimeout(fn, ms),
    clearTimer: (h) => clearTimeout(h as ReturnType<typeof setTimeout>),
    kittyActive: () => isKittyProtocolActive(),
    onStart: () => void startTake(),
    onStop: () => void stopTake(),
    deleteSpaces: (count) => {
      let left = count;
      // Spaces still held back for a finishing take never reached the editor.
      const held = take?.held;
      while (left > 0 && held?.at(-1) === " ") {
        held.pop();
        left -= 1;
      }
      const editor = focusedMainEditor() ?? take?.editor;
      for (let i = 0; i < left; i += 1) editor?.handleInput(BACKSPACE);
      render();
    },
  });
  detector.configure(settings.hotkey, settings.mode);

  /** The main editor, only when it has focus and no overlay/dialog is up. */
  function focusedMainEditor(): EditorLike | undefined {
    if (!tui || tui.hasOverlay()) return undefined;
    // The TUI interface type omits it; pi's TUI class (TuiBase) has it.
    const focused = (tui as unknown as { getFocusedComponent?: () => unknown }).getFocusedComponent?.();
    return asEditor(focused);
  }

  function render(): void {
    tui?.requestRender();
  }

  function usage(): string {
    return detector.effectiveMode === "tap"
      ? `press ${settings.hotkey} to talk, press it again or Escape to stop`
      : `hold ${settings.hotkey} to talk, release to stop`;
  }

  // Registered only to receive the TUI and theme handles; the indicator is drawn on the editor's border.
  const widget: Component = { render: () => [], invalidate() {} };

  const decorated = new WeakSet<object>();
  const restoreEditors: Array<() => void> = [];

  /** Draw the recording indicator at the right end of this editor's top border while it has a take. */
  function decorate(editor: EditorLike): void {
    if (decorated.has(editor)) return;
    decorated.add(editor);
    const own = Object.getOwnPropertyDescriptor(editor, "render");
    const base = editor.render.bind(editor);
    editor.render = (width) => {
      const lines = base(width);
      const t = take;
      const top = lines[0];
      if (!t || t.editor !== editor || !theme || top === undefined) return lines;
      const label = t.phase === "connecting" ? "starting…" : t.phase === "finishing" ? "transcribing…" : "listening…";
      const meter = t.phase === "listening" ? `${theme.fg("muted", renderLevel(t.level, 4).replaceAll(" ", "▁"))} ` : "";
      const text = meter + theme.fg("dim", label);
      const keep = width - visibleWidth(text) - 3;
      if (keep < 1) return lines;
      lines[0] = `${sliceByColumn(top, 0, keep)} ${text} ${sliceByColumn(top, width - 1, 1)}\x1b[0m`;
      return lines;
    };
    restoreEditors.push(() => {
      decorated.delete(editor);
      if (own) Object.defineProperty(editor, "render", own);
      else delete (editor as { render?: unknown }).render;
    });
  }

  /** Text on the cursor's line before the cursor. */
  function textBeforeCursor(editor: EditorLike): string {
    const cursor = editor.getCursor();
    return (editor.getLines()[cursor.line] ?? "").slice(0, cursor.col);
  }

  /** Make the editor show `text` as the live (unfinalized) transcript at the cursor, like Claude Code. */
  function showLive(t: Take, text: string): void {
    if (t.ended) return;
    const trimmed = text.trim();
    const before = textBeforeCursor(t.editor);
    // Something other than a key press changed the editor: leave what is there and carry on at the cursor.
    if (t.shown && !before.endsWith(t.shown)) t.shown = "";
    let target = "";
    if (trimmed) {
      const base = before.slice(0, before.length - t.shown.length);
      target = separatorBefore(base.slice(-1), t.editor.getCursor().col - t.shown.length === 0) + trimmed;
    }
    const { backspaces, insert } = planReplace(t.shown, target);
    for (let i = 0; i < backspaces; i += 1) t.editor.handleInput(BACKSPACE);
    if (insert) t.editor.insertTextAtCursor(insert);
    t.shown = target;
    render();
  }

  function commitFinal(t: Take, text: string): void {
    showLive(t, text);
    if (text.trim()) t.inserted = true;
    t.shown = "";
  }

  /**
   * A key the detector let through while a take is on. The live transcript
   * sits right before the cursor and is rewritten in place, so nothing else
   * may edit around it: while listening it is taken out first (the next
   * result puts it back at the cursor); while the final words are on their
   * way the key waits and is replayed behind them.
   */
  function foreignInput(data: string): { consume: true } | undefined {
    const t = take;
    if (!t || !isEditorInput(data) || focusedMainEditor() !== t.editor) return undefined;
    if (t.phase === "finishing") {
      t.held.push(data);
      return { consume: true };
    }
    if (t.shown) showLive(t, "");
    return undefined;
  }

  function notify(message: string, type: "info" | "warning" | "error"): void {
    ctxRef?.ui.notify(message, type);
  }

  /** The take is over: release the editor, replay held keys, start the hold that was waiting. */
  function settle(t: Take): void {
    t.ended = true;
    if (t.repaint) clearInterval(t.repaint);
    if (take !== t) return;
    take = undefined;
    const held = t.held;
    t.held = [];
    if (focusedMainEditor() === t.editor) for (const data of held) t.editor.handleInput(data);
    render();
    if (queued) {
      queued = false;
      if (detector.phase === "recording") void startTake();
    }
  }

  async function fail(t: Take, message: string): Promise<void> {
    if (t.ended) return;
    notify(message + (t.inserted ? " (kept the text transcribed so far)" : ""), "error");
    // A take that is already finishing no longer owns the hotkey.
    if (take === t && t.phase !== "finishing") detector.cancel();
    settle(t);
    t.stream?.abort();
    await t.mic?.stop();
  }

  async function startTake(): Promise<void> {
    const key = apiKey();
    if (take?.phase === "finishing" && key && settings.enabled) {
      queued = true;
      return;
    }
    const editor = focusedMainEditor();
    if (!key || !editor || take || !settings.enabled) {
      detector.cancel();
      return;
    }
    if (settings.mode === "hold" && detector.effectiveMode === "tap" && !tapNoticeShown) {
      tapNoticeShown = true;
      notify(`This terminal does not report key releases, so ${settings.hotkey} works as tap: press it again or Escape to stop.`, "info");
    }
    decorate(editor);
    const t = new Take(editor);
    take = t;
    render();
    t.repaint = setInterval(render, 250);
    try {
      t.stream = new DeepgramStream(
        key,
        {
          onInterim: (text) => showLive(t, text),
          onFinal: (text) => commitFinal(t, text),
          onError: (message) => void fail(t, message),
        },
        undefined,
        undefined,
        buildListenUrl(settings.region === "auto" ? settings.autoPick?.region : settings.region),
      );
      t.mic = await openMicrophone({
        onAudio: (samples) => {
          t.stream?.sendAudio(samples);
          t.level = Math.max(levelOf(samples), t.level * 0.7);
          // The device takes a moment to deliver after it is opened: `listening…` only once audio is captured.
          if (t.phase === "connecting") {
            t.phase = "listening";
            render();
          }
        },
        onFailure: (message) => void fail(t, message),
      });
      if (t.ended) {
        await t.mic.stop();
        return;
      }
      if (t.stopRequested) await finishTake(t);
    } catch (error) {
      await fail(t, error instanceof Error ? error.message : String(error));
    }
  }

  async function stopTake(): Promise<void> {
    if (queued) {
      queued = false;
      return;
    }
    const t = take;
    if (!t) return;
    if (!t.mic) {
      // Still opening the microphone: startTake finishes the take once it is open.
      t.stopRequested = true;
      return;
    }
    await finishTake(t);
  }

  async function finishTake(t: Take): Promise<void> {
    if (t.phase === "finishing" || t.ended) return;
    t.phase = "finishing";
    render();
    await t.mic?.stop();
    const finalized = (await t.stream?.finish()) ?? true;
    if (t.ended) return;
    if (!finalized) notify("Deepgram did not answer in time: the last words may be missing.", "warning");
    settle(t);
  }

  function shutdown(): void {
    unsubscribe?.();
    unsubscribe = undefined;
    detector.dispose();
    queued = false;
    for (const restore of restoreEditors.splice(0)) restore();
    const t = take;
    take = undefined;
    if (t) {
      t.ended = true;
      if (t.repaint) clearInterval(t.repaint);
      t.stream?.abort();
      void t.mic?.stop();
    }
  }

  function save(): void {
    try {
      saveSettings(path, settings);
    } catch (error) {
      notify(`Could not save voice settings: ${error instanceof Error ? error.message : String(error)}`, "warning");
    }
  }

  /** Auto region: measure in the background and keep the pick for the next take and the next session. */
  async function measureAuto(): Promise<void> {
    if (measuring || settings.region !== "auto" || !settings.enabled) return;
    measuring = true;
    const timings = await measure().catch(() => ({}));
    measuring = false;
    // A fixed region chosen meanwhile turns measuring off.
    if (settings.region !== "auto") return;
    const pick = pickRegion(timings);
    // Every host failed (offline): keep the last good pick rather than falling back to Global.
    if (pick.ms === undefined && settings.autoPick) return;
    settings = { ...settings, autoPick: pick };
    save();
    render();
  }

  function update(patch: Partial<VoiceSettings>): void {
    const was = settings;
    settings = { ...settings, ...patch };
    save();
    if (was.region !== "auto" || !was.enabled) void measureAuto();
    const rebound = settings.hotkey !== was.hotkey || settings.mode !== was.mode;
    if (rebound || !settings.enabled) {
      // Whatever is recording was started under the old settings.
      detector.cancel();
      queued = false;
      void stopTake();
    }
    if (rebound) detector.configure(settings.hotkey, settings.mode);
  }

  pi.on("session_start", (_event, ctx) => {
    if (!ctx.hasUI) return;
    ctxRef = ctx;
    void measureAuto();
    ctx.ui.setWidget(WIDGET_KEY, (ui, th) => {
      tui = ui;
      theme = th;
      return widget;
    });
    unsubscribe?.();
    unsubscribe = ctx.ui.onTerminalInput((data) => {
      const result = hotkeyInput(data);
      return result?.consume ? result : (foreignInput(data) ?? result);
    });
  });

  function hotkeyInput(data: string): ReturnType<HotkeyDetector["handle"]> {
    if (!settings.enabled || !apiKey()) {
      if (detector.phase !== "idle" && !take) detector.reset();
      return undefined;
    }
    if (!focusedMainEditor()) {
      if (detector.phase === "idle") {
        detector.reset();
        return undefined;
      }
      if (detector.effectiveMode === "tap") {
        // No key is held in tap mode, so a take would run on behind the dialog that took the focus.
        detector.cancel();
        queued = false;
        void stopTake();
        return undefined;
      }
    }
    return detector.handle(data);
  }

  pi.on("session_shutdown", () => {
    shutdown();
  });

  pi.registerCommand(COMMAND, {
    description: "Toggle streaming voice input (Deepgram)",
    handler: async (_args, ctx) => {
      update({ enabled: !settings.enabled });
      const state = `Streaming voice ${settings.enabled ? "on" : "off"}`;
      if (!apiKey()) ctx.ui.notify(`${state}, but ${KEY_ENV} is not set. ${KEY_HELP}`, "warning");
      else ctx.ui.notify(settings.enabled ? `${state}: ${usage()}` : state, "info");
    },
  });

  pi.registerCommand(SETTINGS_COMMAND, {
    description: "Voice input settings: on/off, hotkey, hold or tap, region",
    handler: async (_args, ctx) => {
      if (ctx.mode !== "tui") {
        ctx.ui.notify(`/${SETTINGS_COMMAND} needs the terminal UI`, "error");
        return;
      }
      await ctx.ui.custom<void>((ui, th, keybindings, done) =>
        createSettingsMenu(ui, th, keybindings, { current: () => settings, update }, () => done()),
      );
    },
  });
}
