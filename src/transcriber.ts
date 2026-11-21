import { levelOf, openMicrophone, type Microphone } from "./audio.ts";
import { buildListenUrl, DeepgramStream, type Region } from "./deepgram.ts";

export interface TranscriberCallbacks {
  /** Audio is being captured (once). */
  onListening(): void;
  /** Input level 0..1. */
  onLevel(level: number): void;
  onInterim(text: string): void;
  onFinal(text: string): void;
  /** Fatal (once). Finals already delivered stay valid. */
  onError(message: string): void;
}

/** Where a take's words come from: the microphone here, or the Mac's through the voice bridge. */
export interface Transcriber {
  /** Opens capture. Rejects if it cannot; failures after that go to `onError`. */
  start(cb: TranscriberCallbacks): Promise<void>;
  /** Stops capture and waits for the last words. False if they may be missing. Never throws. */
  finish(): Promise<boolean>;
  /** Drops everything at once. Never throws. */
  abort(): Promise<void>;
}

/** The native microphone streamed to Deepgram from this machine. */
export class LocalTranscriber implements Transcriber {
  private mic: Microphone | undefined;
  private stream: DeepgramStream | undefined;
  private aborted = false;
  private readonly key: string;
  private readonly region: Region | undefined;

  constructor(key: string, region: Region | undefined) {
    this.key = key;
    this.region = region;
  }

  async start(cb: TranscriberCallbacks): Promise<void> {
    this.stream = new DeepgramStream(
      this.key,
      { onInterim: cb.onInterim, onFinal: cb.onFinal, onError: cb.onError },
      undefined,
      undefined,
      buildListenUrl(this.region),
    );
    let listening = false;
    const mic = await openMicrophone({
      onAudio: (samples) => {
        this.stream?.sendAudio(samples);
        cb.onLevel(levelOf(samples));
        // The device takes a moment to deliver after it is opened: listening only once audio is captured.
        if (!listening) {
          listening = true;
          cb.onListening();
        }
      },
      onFailure: cb.onError,
    });
    this.mic = mic;
    if (this.aborted) await mic.stop();
  }

  async finish(): Promise<boolean> {
    await this.mic?.stop();
    return (await this.stream?.finish()) ?? true;
  }

  async abort(): Promise<void> {
    this.aborted = true;
    this.stream?.abort();
    await this.mic?.stop();
  }
}
