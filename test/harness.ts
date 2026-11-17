// Runs the real extension against a real pi-tui Editor, a fake WebSocket and a mocked microphone.
import { mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { mock } from "node:test";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { Editor, isKeyRelease, KeybindingsManager, setKittyProtocolActive, TUI_KEYBINDINGS, type TUI } from "@earendil-works/pi-tui";
import streamingVoice from "../src/extension.ts";

export const TEST_KEY = "dg_test_key_0123456789";
process.env.DEEPGRAM_API_KEY = TEST_KEY;

// ---- fake microphone -------------------------------------------------------
export interface FakeRecorder {
  opts: { onChunk(c: { samples: Float32Array }): void; onFailure(e: Error & { code?: string }): void };
  isRecording: boolean;
  stopped: boolean;
  closed: boolean;
}
export const mic = {
  recorders: [] as FakeRecorder[],
  /** When set, Recorder.open waits for this promise (a slow device open). */
  gate: undefined as Promise<void> | undefined,
  permission: "granted",
};
mock.module("@handy-computer/recorder", {
  namedExports: {
    permissionStatus: () => mic.permission,
    Recorder: {
      async open(opts: FakeRecorder["opts"]) {
        if (mic.gate) await mic.gate;
        const r = {
          opts,
          isRecording: false,
          stopped: false,
          closed: false,
          info: { format: { sampleRate: 16000, channels: 1 } },
          start() {
            r.isRecording = true;
          },
          async stop() {
            r.isRecording = false;
            r.stopped = true;
          },
          async close() {
            r.closed = true;
          },
        };
        mic.recorders.push(r);
        return r;
      },
    },
  },
});

// ---- fake WebSocket --------------------------------------------------------
export class FakeSocket {
  static instances: FakeSocket[] = [];
  /** Answer a client close / CloseStream with a normal close. */
  static autoClose = true;
  readyState = 0;
  binaryType = "";
  sent: Array<string | Uint8Array> = [];
  closeCalls: Array<number | undefined> = [];
  onopen: ((ev: unknown) => void) | null = null;
  onmessage: ((ev: { data: unknown }) => void) | null = null;
  onerror: ((ev: unknown) => void) | null = null;
  onclose: ((ev: { code: number; reason: string }) => void) | null = null;
  readonly url: string;
  readonly init: unknown;
  constructor(url: string, init: unknown) {
    this.url = url;
    this.init = init;
    FakeSocket.instances.push(this);
  }
  send(data: string | Uint8Array): void {
    this.sent.push(data);
    if (FakeSocket.autoClose && typeof data === "string" && data.includes("CloseStream")) {
      setTimeout(() => this.serverClose(1000, ""), 1);
    }
  }
  close(code?: number): void {
    this.closeCalls.push(code);
    if (this.readyState === 3) return;
    this.readyState = 2;
    if (FakeSocket.autoClose) setTimeout(() => this.serverClose(1000, ""), 1);
  }
  open(): void {
    this.readyState = 1;
    this.onopen?.({});
  }
  results(transcript: string, extra: Record<string, unknown> = {}): void {
    this.onmessage?.({
      data: JSON.stringify({ type: "Results", channel: { alternatives: [{ transcript }] }, is_final: false, ...extra }),
    });
  }
  interim(t: string): void {
    this.results(t);
  }
  final(t: string, extra: Record<string, unknown> = {}): void {
    this.results(t, { is_final: true, ...extra });
  }
  serverClose(code: number, reason: string): void {
    if (this.readyState === 3) return;
    this.readyState = 3;
    this.onclose?.({ code, reason });
  }
  get json(): string[] {
    return this.sent.filter((s): s is string => typeof s === "string");
  }
}
(globalThis as { WebSocket: unknown }).WebSocket = FakeSocket;

// ---- pi / tui fakes --------------------------------------------------------
export const K_RELEASE = "\x1b[32;1:3u";
export const OTHER_RELEASE = "\x1b[97;1:3u";
export const ALT_V = "\x1b[118;3u";
export const ALT_V_RELEASE = "\x1b[118;3:3u";
export const sleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));

interface Focusable {
  handleInput?(data: string): void;
  render?(width: number): string[];
  wantsKeyRelease?: boolean;
}

export interface Rig {
  editor: Editor;
  notifications: Array<{ message: string; type: string }>;
  overlay: boolean;
  focused: Focusable | undefined;
  /** Feed raw terminal input the way pi-tui's handleTerminalInput does. */
  feed(data: string): "consumed" | "passed";
  widgetLines(): string[];
  /** What the focused component (the settings menu) shows. */
  screen(): string;
  /** Run a slash command; resolves when its handler returns. */
  command(name?: string): Promise<void>;
  shutdown(): void;
  /** Kitty-path Space hold: press and wait past the 350 ms threshold. */
  hold(): Promise<void>;
  release(): void;
  socket(): FakeSocket;
  recorder(): FakeRecorder;
  text(): string;
  savedSettings(): unknown;
}

export function makeRig(opts: { kitty?: boolean } = {}): Rig {
  const agentDir = mkdtempSync(join(tmpdir(), "psv-agent-"));
  process.env.PI_CODING_AGENT_DIR = agentDir;
  FakeSocket.instances = [];
  FakeSocket.autoClose = true;
  mic.recorders = [];
  mic.gate = undefined;
  mic.permission = "granted";
  setKittyProtocolActive(opts.kitty ?? true);

  const handlers = new Map<string, (event: unknown, ctx: unknown) => unknown>();
  const commands = new Map<string, (args: string, ctx: unknown) => Promise<void>>();
  let listener: ((data: string) => { consume?: boolean; data?: string } | undefined) | undefined;
  let widget: { render(width: number): string[] } | undefined;

  const rig = { notifications: [], overlay: false, focused: undefined } as unknown as Rig;
  const tui = {
    requestRender: () => {},
    hasOverlay: () => rig.overlay,
    getFocusedComponent: () => rig.focused,
  } as unknown as TUI;
  const ident = (s: string) => s;
  rig.editor = new Editor(tui, {
    borderColor: ident,
    selectList: { selectedPrefix: ident, selectedText: ident, description: ident, scrollInfo: ident, noMatch: ident },
  });
  rig.focused = rig.editor;
  const theme = { fg: (_color: string, s: string) => s, bold: ident };
  const keybindings = new KeybindingsManager({ ...TUI_KEYBINDINGS, "app.model.select": { defaultKeys: "ctrl+l" } });

  const ctx = {
    hasUI: true,
    mode: "tui",
    ui: {
      setWidget: (_key: string, factory: (t: unknown, th: unknown) => { render(width: number): string[] }) => {
        widget = factory(tui, theme);
      },
      onTerminalInput: (fn: NonNullable<typeof listener>) => {
        listener = fn;
        return () => {
          if (listener === fn) listener = undefined;
        };
      },
      notify: (message: string, type: string) => rig.notifications.push({ message, type }),
      custom: (factory: (t: unknown, th: unknown, kb: unknown, done: (result: unknown) => void) => Focusable) =>
        new Promise<unknown>((resolve) => {
          const previous = rig.focused;
          rig.focused = factory(tui, theme, keybindings, (result) => {
            rig.focused = previous;
            resolve(result);
          });
        }),
    },
  };
  const pi = {
    on: (event: string, handler: (event: unknown, ctx: unknown) => unknown) => handlers.set(event, handler),
    registerCommand: (name: string, def: { handler: (args: string, ctx: unknown) => Promise<void> }) => {
      commands.set(name, def.handler);
    },
  };
  streamingVoice(pi as unknown as ExtensionAPI);
  handlers.get("session_start")?.({}, ctx);

  rig.feed = (data) => {
    if (listener?.(data)?.consume) return "consumed";
    const focused = rig.focused;
    if (focused?.handleInput && !(isKeyRelease(data) && !focused.wantsKeyRelease)) focused.handleInput(data);
    return "passed";
  };
  rig.widgetLines = () => widget?.render(120) ?? [];
  rig.screen = () => (rig.focused?.render?.(100) ?? []).join("\n");
  rig.command = async (name = "voice") => {
    await commands.get(name)?.("", ctx);
  };
  rig.shutdown = () => {
    handlers.get("session_shutdown")?.({}, ctx);
  };
  rig.hold = async () => {
    rig.feed(OTHER_RELEASE); // a key release seen earlier → kitty path
    rig.feed(" ");
    await sleep(380);
  };
  rig.release = () => {
    rig.feed(K_RELEASE);
  };
  rig.socket = () => FakeSocket.instances[FakeSocket.instances.length - 1]!;
  rig.recorder = () => mic.recorders[mic.recorders.length - 1]!;
  rig.text = () => rig.editor.getText();
  rig.savedSettings = () => JSON.parse(readFileSync(join(agentDir, "pi-streaming-voice.json"), "utf8"));
  return rig;
}

/** setInterval/setTimeout handles still alive (leak check). */
export function activeTimers(): number {
  return process.getActiveResourcesInfo().filter((r) => r === "Timeout").length;
}
