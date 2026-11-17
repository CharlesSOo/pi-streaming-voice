import { SAMPLE_RATE } from "./deepgram.ts";

/** 50 ms chunks: within Deepgram's recommended 20–100 ms. */
const FRAMES_PER_CHUNK = 800;

export interface Microphone {
  /** Stops capture and releases the device. Never throws. */
  stop(): Promise<void>;
}

export interface MicSinks {
  onAudio(samples: Float32Array): void;
  onFailure(message: string): void;
}

export class MicPermissionError extends Error {
  constructor() {
    super(
      "Microphone access denied. Allow your terminal in System Settings → Privacy & Security → Microphone, then restart it.",
    );
    this.name = "MicPermissionError";
  }
}

function isPermissionDenied(error: unknown): boolean {
  return typeof error === "object" && error !== null && (error as { code?: unknown }).code === "PermissionDenied";
}

/** Opens the default microphone at 16 kHz mono and starts streaming chunks into `sinks`. */
export async function openMicrophone(sinks: MicSinks): Promise<Microphone> {
  // Lazy import: the native module loads only when someone actually talks.
  const { Recorder, permissionStatus } = await import("@handy-computer/recorder");
  if (process.platform === "darwin" && permissionStatus() === "denied") throw new MicPermissionError();

  let recorder;
  try {
    recorder = await Recorder.open({
      sampleRate: SAMPLE_RATE,
      channels: "mono",
      framesPerChunk: FRAMES_PER_CHUNK,
      collect: false,
      onChunk: ({ samples }) => sinks.onAudio(samples),
      onFailure: (error) =>
        sinks.onFailure(isPermissionDenied(error) ? new MicPermissionError().message : `Microphone stopped: ${error.message}`),
    });
  } catch (error) {
    if (isPermissionDenied(error)) throw new MicPermissionError();
    throw error;
  }
  try {
    const { format } = recorder.info;
    if (format.sampleRate !== SAMPLE_RATE || format.channels !== 1) {
      throw new Error(`Recorder delivers ${format.sampleRate} Hz × ${format.channels}; expected ${SAMPLE_RATE} Hz mono`);
    }
    recorder.start();
  } catch (error) {
    await recorder.close().catch(() => undefined);
    if (isPermissionDenied(error)) throw new MicPermissionError();
    throw error;
  }
  const opened = recorder;
  let stopped = false;
  return {
    async stop() {
      if (stopped) return;
      stopped = true;
      try {
        if (opened.isRecording) await opened.stop();
      } catch {
        // nothing useful to do
      } finally {
        await opened.close().catch(() => undefined);
      }
    },
  };
}

/** RMS level of a chunk mapped to 0..1 on a -60..0 dBFS scale. */
export function levelOf(samples: Float32Array): number {
  if (samples.length === 0) return 0;
  let sum = 0;
  for (let i = 0; i < samples.length; i += 1) {
    const s = samples[i] ?? 0;
    sum += s * s;
  }
  const rms = Math.sqrt(sum / samples.length);
  if (rms <= 0) return 0;
  const db = 20 * Math.log10(rms);
  return Math.max(0, Math.min(1, (db + 60) / 60));
}

const BLOCKS = " ▁▂▃▄▅▆▇█";

/** A small level meter: `width` cells, filled left to right. */
export function renderLevel(level: number, width = 8): string {
  const total = Math.max(0, Math.min(1, level)) * width;
  let out = "";
  for (let i = 0; i < width; i += 1) {
    const fill = Math.max(0, Math.min(1, total - i));
    out += BLOCKS[Math.round(fill * (BLOCKS.length - 1))] ?? " ";
  }
  return out;
}
