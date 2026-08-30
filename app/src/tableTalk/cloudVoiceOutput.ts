import type { CharacterDialogueEmission } from "./types";

type FetchLike = typeof fetch;

export class CloudTableTalkVoiceOutput {
  private enabled = false;
  private volume = 0.8;
  private busy = false;
  private readonly fetcher: FetchLike;
  private readonly onError?: (message: string) => void;
  private audioContext: AudioContext | null = null;
  private activeSource: AudioBufferSourceNode | null = null;
  private voicePackManifestPromise: Promise<Record<string, string>> | null = null;

  constructor(options?: {
    enabled?: boolean;
    fetcher?: FetchLike;
    onError?: (message: string) => void;
  }) {
    this.enabled = options?.enabled ?? false;
    this.fetcher = options?.fetcher ?? ((input: RequestInfo | URL, init?: RequestInit) => fetch(input, init));
    this.onError = options?.onError;
  }

  setEnabled(enabled: boolean) {
    this.enabled = enabled;
    if (!enabled) this.cancel();
  }

  setVolume(volume: number) {
    this.volume = Math.max(0, Math.min(1, volume));
  }

  async speak(line: CharacterDialogueEmission, onPlaybackStart?: () => void): Promise<boolean> {
    if (!this.enabled || this.busy) return false;
    this.busy = true;
    try {
      const packedAudio = await this.readVoicePack(line);
      if (!packedAudio) return false;
      onPlaybackStart?.();
      return await this.playAudioBuffer(packedAudio);
    } catch (error) {
      const message = error instanceof Error ? error.message : "Unknown prerecorded voice error.";
      this.onError?.(message);
      return false;
    } finally {
      this.busy = false;
    }
  }

  private async readVoicePack(line: CharacterDialogueEmission): Promise<ArrayBuffer | null> {
    if (typeof window === "undefined") return null;
    if (!this.voicePackManifestPromise) {
      const manifestUrl = new URL("table-talk-voice/manifest.json", document.baseURI);
      this.voicePackManifestPromise = this.fetcher(manifestUrl)
        .then(response => response.ok ? response.json() as Promise<Record<string, string>> : {})
        .catch(() => ({}));
    }
    const manifest = await this.voicePackManifestPromise;
    const clipPath = manifest[`${line.characterId}|${line.text}`];
    if (!clipPath) return null;
    try {
      const response = await this.fetcher(new URL(clipPath, document.baseURI));
      return response.ok ? await response.arrayBuffer() : null;
    } catch {
      return null;
    }
  }

  cancel() {
    if (this.activeSource) {
      try {
        this.activeSource.stop();
      } catch {
        // Ignore if source is already ended.
      }
      this.activeSource = null;
    }
    this.busy = false;
  }

  private async playAudioBuffer(audioData: ArrayBuffer): Promise<boolean> {
    const context = this.getAudioContext();
    if (!context) {
      this.onError?.("Browser does not support AudioContext for prerecorded voice playback.");
      return false;
    }
    if (context.state === "suspended") {
      try {
        await context.resume();
      } catch {
        this.onError?.("Prerecorded voice is blocked by browser audio permissions.");
        return false;
      }
    }

    let decoded: AudioBuffer;
    try {
      decoded = await context.decodeAudioData(audioData.slice(0));
    } catch {
      this.onError?.("Prerecorded voice audio decode failed.");
      return false;
    }

    const source = context.createBufferSource();
    const gain = context.createGain();
    gain.gain.value = this.volume;
    source.buffer = decoded;
    source.connect(gain).connect(context.destination);
    this.activeSource = source;

    await new Promise<void>(resolve => {
      source.onended = () => {
        if (this.activeSource === source) this.activeSource = null;
        resolve();
      };
      source.start();
    });
    return true;
  }

  private getAudioContext(): AudioContext | null {
    if (typeof window === "undefined") return null;
    if (this.audioContext) return this.audioContext;
    const AudioCtx = window.AudioContext || (window as unknown as { webkitAudioContext?: typeof AudioContext }).webkitAudioContext;
    if (!AudioCtx) return null;
    this.audioContext = new AudioCtx();
    return this.audioContext;
  }
}
