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
import { renderLevel } from "./audio.ts";
import { BridgeConnector, BridgeTranscriber, bridgeConfigured, bridgeTokenPath, loadBridgeConfig } from "./bridge-client.ts";
import { LocalTranscriber, type Transcriber } from "./transcriber.ts";
import { measureRegions, pickRegion, type MeasureRegions } from "./region-probe.ts";
import { BACKSPACE, HotkeyDetector } from "./hold-detector.ts";
import { loadSettings, saveSettings, settingsPath, type VoiceSettings } from "./settings.ts";
import { createSettingsMenu } from "./settings-menu.ts";
import { planReplace, separatorBefore } from "./text.ts";

export const COMMAND = "voice";
export const SETTINGS_COMMAND = "voice-settings";
const WIDGET_KEY = "pi-streaming-voice";
const KEY_ENV = "DEEPGRAM_API_KEY";
/** Auto region: a pick older than this is measured again. */
const AUTO_MAX_AGE_MS = 24 * 60 * 60 * 1000;
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
  transcriber: Transcriber | undefined;
  /** Capture is open: a stop can finish the take right away. */
  started = false;
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

/** Where takes come from on this host. */
export interface TranscriberSource {
  /** `local`: this machine's microphone and Deepgram key. `bridge`: the Mac's, through the voice bridge. */
  kind: "local" | "bridge";
  /** Whether a take can start at all; without one the hotkey is inert. */
  available(): boolean;
  /** Why it is not available, and how to fix it. */
  help(): string;
  /** Throws with a message for the user if this take cannot be set up. */
  create(settings: VoiceSettings): Transcriber;
  /** Get ready for the next take ahead of time (session start). */
  warm?(): void;
  /** Session over: let go of anything kept ready. */
  dispose?(): void;
}

export function localSource(): TranscriberSource {
  return {
    kind: "local",
    available: () => apiKey() !== undefined,
    help: () => `${KEY_ENV} is not set. ${KEY_HELP}`,
    create: (settings) => {
      const key = apiKey();
      if (!key) throw new Error(`${KEY_ENV} is not set`);
      return new LocalTranscriber(key, settings.region === "auto" ? settings.autoPick?.region : settings.region);
    },
  };
}

export function bridgeSource(agentDir: string): TranscriberSource {
  let connector: BridgeConnector | undefined;
  const get = () => (connector ??= new BridgeConnector(() => loadBridgeConfig(agentDir)));
  return {
    kind: "bridge",
    available: () => bridgeConfigured(agentDir),
    help: () =>
      `the voice bridge is not set up on this host (no ${bridgeTokenPath(agentDir)}). Run the bridge install on the Mac; see "Remote hosts" in the README.`,
    create: () => new BridgeTranscriber(get()),
    // An authenticated idle connection kept open, so pressing the hotkey only sends `start`.
    warm: () => {
      if (bridgeConfigured(agentDir)) get().warm();
    },
    dispose: () => {
      connector?.dispose();
      connector = undefined;
    },
  };
}

/** macOS: this machine's microphone. Elsewhere: the Mac's, through the voice bridge (it needs no Deepgram key here). */
export function defaultSource(agentDir: string): TranscriberSource {
  return process.platform === "darwin" ? localSource() : bridgeSource(agentDir);
}

/** `measure` and `source` are replaced in tests; pi calls this with `pi` only. */
export default function streamingVoice(
  pi: ExtensionAPI,
  measure: MeasureRegions = measureRegions,
  source: TranscriberSource = defaultSource(getAgentDir()),
): void {
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
  /** The Auto region measurement in flight, if any. */
  let probe: AbortController | undefined;

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
    const wrapper = (width: number): string[] => {
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
    editor.render = wrapper;
    restoreEditors.push(() => {
      // Something else has wrapped the editor since: leave it, ours draws nothing without a take.
      if (editor.render !== wrapper) return;
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
    await t.transcriber?.abort();
  }

  async function startTake(): Promise<void> {
    const available = source.available();
    if (take?.phase === "finishing" && available && settings.enabled) {
      queued = true;
      return;
    }
    const editor = focusedMainEditor();
    if (!available || !editor || take || !settings.enabled) {
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
      t.transcriber = source.create(settings);
      await t.transcriber.start({
        onListening: () => {
          // `listening…` only once audio is captured.
          if (t.phase === "connecting") {
            t.phase = "listening";
            render();
          }
        },
        onLevel: (level) => {
          t.level = Math.max(level, t.level * 0.7);
        },
        onInterim: (text) => showLive(t, text),
        onFinal: (text) => commitFinal(t, text),
        onError: (message) => void fail(t, message),
      });
      t.started = true;
      if (t.ended) {
        await t.transcriber.abort();
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
    if (!t.started) {
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
    const finalized = (await t.transcriber?.finish()) ?? true;
    if (t.ended) return;
    if (!finalized) notify("Deepgram did not answer in time: the last words may be missing.", "warning");
    settle(t);
  }

  function shutdown(): void {
    source.dispose?.();
    unsubscribe?.();
    unsubscribe = undefined;
    detector.dispose();
    queued = false;
    probe?.abort();
    probe = undefined;
    for (const restore of restoreEditors.splice(0)) restore();
    const t = take;
    take = undefined;
    if (t) {
      t.ended = true;
      if (t.repaint) clearInterval(t.repaint);
      void t.transcriber?.abort();
    }
  }

  function save(): void {
    try {
      saveSettings(path, settings);
    } catch (error) {
      notify(`Could not save voice settings: ${error instanceof Error ? error.message : String(error)}`, "warning");
    }
  }

  /**
   * Auto region: measure in the background, at most once a day unless `force`d, and keep the pick for the next
   * take and the next sessions.
   */
  async function measureAuto(force = false): Promise<void> {
    // On a bridge host the Mac picks the region.
    if (probe || source.kind !== "local" || settings.region !== "auto" || !settings.enabled) return;
    const age = Date.now() - (settings.autoPick?.at ?? -Infinity);
    if (!force && age >= 0 && age < AUTO_MAX_AGE_MS) return;
    const mine = new AbortController();
    probe = mine;
    const timings = await measure(mine.signal).catch(() => ({}));
    // Shut down meanwhile: the result is dropped.
    if (mine.signal.aborted) return;
    probe = undefined;
    const found = pickRegion(timings);
    // Every host failed (offline): keep the last good pick and its age, so the next session tries again.
    if (found.ms === undefined && settings.autoPick) return;
    const autoPick = found.ms === undefined ? found : { ...found, at: Date.now() };
    // A fixed region chosen meanwhile turns measuring off.
    if (settings.region === "auto") settings = { ...settings, autoPick };
    try {
      // The file may be newer than this instance (after /reload, or another pi): change only the pick in it.
      const file = loadSettings(path);
      if (file.region === "auto") saveSettings(path, { ...file, autoPick });
    } catch (error) {
      notify(`Could not save voice settings: ${error instanceof Error ? error.message : String(error)}`, "warning");
    }
    render();
  }

  function update(patch: Partial<VoiceSettings>): void {
    const was = settings;
    settings = { ...settings, ...patch };
    save();
    // Choosing Auto measures at once; turning voice on only if the pick is a day old.
    if (was.region !== "auto") void measureAuto(true);
    else if (!was.enabled) void measureAuto();
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
    source.warm?.();
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
    if (!settings.enabled || !source.available()) {
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
      if (!source.available()) ctx.ui.notify(`${state}, but ${source.help()}`, "warning");
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
        createSettingsMenu(ui, th, keybindings, { current: () => settings, update, regionOnMac: source.kind === "bridge" }, () => done()),
      );
    },
  });
}
