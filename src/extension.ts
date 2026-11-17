import { getAgentDir, type ExtensionAPI, type ExtensionContext, type Theme } from "@earendil-works/pi-coding-agent";
import { isKittyProtocolActive, truncateToWidth, type Component, type TUI } from "@earendil-works/pi-tui";
import { levelOf, openMicrophone, renderLevel, type Microphone } from "./audio.ts";
import { DeepgramStream } from "./deepgram.ts";
import { BACKSPACE, SpaceHoldDetector } from "./hold-detector.ts";
import { loadSettings, saveSettings, settingsPath, type VoiceSettings } from "./settings.ts";
import { planReplace, separatorBefore } from "./text.ts";

export const COMMAND = "voice";
const WIDGET_KEY = "pi-streaming-voice";
const KEY_ENV = "DEEPGRAM_API_KEY";
const KEY_HELP = `Set ${KEY_ENV} in your environment, e.g. fish: set -Ux ${KEY_ENV} <your-key>  (bash/zsh: export ${KEY_ENV}=<your-key>), then restart pi.`;

/** The editor surface we use: pi-tui's Editor (and CustomEditor subclasses). */
interface EditorLike {
  handleInput(data: string): void;
  insertTextAtCursor(text: string): void;
  getLines(): string[];
  getCursor(): { line: number; col: number };
}

function asEditor(component: unknown): EditorLike | undefined {
  const c = component as Partial<EditorLike> | null | undefined;
  if (
    c &&
    typeof c.insertTextAtCursor === "function" &&
    typeof c.handleInput === "function" &&
    typeof c.getLines === "function" &&
    typeof c.getCursor === "function"
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
  /** Unfinalized transcript currently typed in the editor, including its leading separator. */
  shown = "";
  /** False once the user moved the cursor or edited mid-take: stop rewriting, insert finals only. */
  live = true;
  level = 0;
  startedAt = Date.now();
  stopRequested = false;
  mic: Microphone | undefined;
  stream: DeepgramStream | undefined;
  inserted = false;
  failed = false;
  repaint: ReturnType<typeof setInterval> | undefined;
  readonly editor: EditorLike;
  constructor(editor: EditorLike) {
    this.editor = editor;
  }
}

export default function streamingVoice(pi: ExtensionAPI): void {
  const path = settingsPath(getAgentDir());
  let settings: VoiceSettings = loadSettings(path);
  let tui: TUI | undefined;
  let theme: Theme | undefined;
  let ctxRef: ExtensionContext | undefined;
  let unsubscribe: (() => void) | undefined;
  let take: Take | undefined;

  const detector = new SpaceHoldDetector({
    now: () => performance.now(),
    setTimer: (fn, ms) => setTimeout(fn, ms),
    clearTimer: (h) => clearTimeout(h as ReturnType<typeof setTimeout>),
    kittyActive: () => isKittyProtocolActive(),
    onStart: () => void startTake(),
    onStop: () => void stopTake(),
    deleteSpaces: (count) => {
      const editor = focusedMainEditor() ?? take?.editor;
      for (let i = 0; i < count; i += 1) editor?.handleInput(BACKSPACE);
      tui?.requestRender();
    },
  });

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

  const widget: Component = {
    render(width: number): string[] {
      const t = take;
      if (!t || !theme) return [];
      const elapsed = Math.floor((Date.now() - t.startedAt) / 1000);
      const clock = `${Math.floor(elapsed / 60)}:${String(elapsed % 60).padStart(2, "0")}`;
      const label =
        t.phase === "connecting" ? "starting…" : t.phase === "finishing" ? "finishing…" : "listening — release Space to stop";
      const head = `${theme.fg("error", "●")} ${theme.fg("accent", renderLevel(t.level))} ${theme.fg("muted", clock)} ${theme.fg("dim", label)}`;
      return [truncateToWidth(head, width)];
    },
    invalidate() {},
  };

  /** Text on the cursor's line before the cursor. */
  function textBeforeCursor(editor: EditorLike): string {
    const cursor = editor.getCursor();
    return (editor.getLines()[cursor.line] ?? "").slice(0, cursor.col);
  }

  /** Make the editor show `text` as the live (unfinalized) transcript at the cursor, like Claude Code. */
  function showLive(t: Take, text: string): void {
    const trimmed = text.trim();
    const before = textBeforeCursor(t.editor);
    if (t.shown && !before.endsWith(t.shown)) {
      // The user moved the cursor or edited: leave their text alone from now on.
      t.live = false;
      t.shown = "";
    }
    if (!t.live) return;
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
    if (t.live) {
      showLive(t, text);
    }
    if (!t.live) {
      // Fallback: append the final segment at wherever the cursor is.
      const before = textBeforeCursor(t.editor);
      const trimmed = text.trim();
      if (trimmed) t.editor.insertTextAtCursor(separatorBefore(before.slice(-1), t.editor.getCursor().col === 0) + trimmed);
      render();
    }
    if (text.trim()) t.inserted = true;
    t.shown = "";
  }

  function notify(message: string, type: "info" | "warning" | "error"): void {
    ctxRef?.ui.notify(message, type);
  }

  async function fail(t: Take, message: string): Promise<void> {
    if (t.failed) return;
    t.failed = true;
    if (t.repaint) clearInterval(t.repaint);
    notify(message + (t.inserted ? " (kept the text transcribed so far)" : ""), "error");
    if (take === t) {
      detector.cancel();
      take = undefined;
    }
    t.stream?.abort();
    await t.mic?.stop();
    render();
  }

  async function startTake(): Promise<void> {
    const key = apiKey();
    const editor = focusedMainEditor();
    if (!key || !editor || take || !settings.enabled) {
      detector.cancel();
      return;
    }
    const t = new Take(editor);
    take = t;
    render();
    const repaint = setInterval(render, 250);
    try {
      t.stream = new DeepgramStream(key, {
        onInterim: (text) => showLive(t, text),
        onFinal: (text) => commitFinal(t, text),
        onError: (message) => void fail(t, message),
      });
      t.mic = await openMicrophone({
        onAudio: (samples) => {
          t.stream?.sendAudio(samples);
          t.level = Math.max(levelOf(samples), t.level * 0.7);
        },
        onFailure: (message) => void fail(t, message),
      });
      if (t.failed) {
        await t.mic.stop();
        return;
      }
      t.phase = "listening";
      render();
      if (t.stopRequested) await finishTake(t);
    } catch (error) {
      await fail(t, error instanceof Error ? error.message : String(error));
    } finally {
      if (t.failed || take !== t) clearInterval(repaint);
      else t.repaint = repaint;
    }
  }

  async function stopTake(): Promise<void> {
    const t = take;
    if (!t) return;
    if (t.phase === "connecting") {
      t.stopRequested = true;
      return;
    }
    await finishTake(t);
  }

  async function finishTake(t: Take): Promise<void> {
    if (t.phase === "finishing" || t.failed) return;
    t.phase = "finishing";
    render();
    await t.mic?.stop();
    await t.stream?.finish();
    if (t.repaint) clearInterval(t.repaint);
    if (take === t) take = undefined;
    render();
  }

  function shutdown(): void {
    unsubscribe?.();
    unsubscribe = undefined;
    detector.dispose();
    const t = take;
    take = undefined;
    if (t) {
      t.failed = true;
      if (t.repaint) clearInterval(t.repaint);
      t.stream?.abort();
      void t.mic?.stop();
    }
  }

  pi.on("session_start", (_event, ctx) => {
    if (!ctx.hasUI) return;
    ctxRef = ctx;
    ctx.ui.setWidget(WIDGET_KEY, (ui, th) => {
      tui = ui;
      theme = th;
      return widget;
    });
    unsubscribe?.();
    unsubscribe = ctx.ui.onTerminalInput((data) => {
      if (!settings.enabled || !apiKey()) {
        if (detector.phase !== "idle" && !take) detector.reset();
        return undefined;
      }
      if (detector.phase === "idle" || detector.phase === "kittyPending") {
        if (!focusedMainEditor()) {
          detector.reset();
          return undefined;
        }
      }
      return detector.handle(data);
    });
  });

  pi.on("session_shutdown", () => {
    shutdown();
  });

  pi.registerCommand(COMMAND, {
    description: "Toggle hold-Space streaming voice input (Deepgram)",
    handler: async (_args, ctx) => {
      settings = { enabled: !settings.enabled };
      try {
        saveSettings(path, settings);
      } catch (error) {
        ctx.ui.notify(`Could not save voice setting: ${error instanceof Error ? error.message : String(error)}`, "warning");
      }
      if (!settings.enabled) {
        detector.cancel();
        const t = take;
        if (t) await finishTake(t);
        ctx.ui.notify("Streaming voice off", "info");
        return;
      }
      if (!apiKey()) {
        ctx.ui.notify(`Streaming voice on, but ${KEY_ENV} is not set. ${KEY_HELP}`, "warning");
        return;
      }
      ctx.ui.notify("Streaming voice on — hold Space to talk, release to stop", "info");
    },
  });
}
