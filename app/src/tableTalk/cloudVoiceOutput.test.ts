import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { CloudTableTalkVoiceOutput } from "./cloudVoiceOutput";
import type { CharacterDialogueEmission } from "./types";

const line: CharacterDialogueEmission = {
  characterId: "arthur",
  characterName: "Arthur",
  text: "A strong hand. I have no complaints.",
  eventType: "large_hand_scored",
  emotion: "competitive",
  timestamp: 1,
  event: { type: "large_hand_scored", actorIndex: 1, points: 12 },
  context: {
    level: "chatty",
    playerCount: 2,
    dealerIndex: 0,
    runningCount: 0,
    scores: [],
    participants: [],
  },
};

class MockSource {
  onended: (() => void) | null = null;
  buffer: unknown = null;
  connect() { return this; }
  start() { queueMicrotask(() => this.onended?.()); }
  stop() { this.onended?.(); }
}

class MockAudioContext {
  state = "running";
  destination = {};
  source = new MockSource();
  resume = vi.fn(async () => undefined);
  decodeAudioData = vi.fn(async () => ({}));
  createBufferSource = vi.fn(() => this.source);
  createGain = vi.fn(() => ({ gain: { value: 0 }, connect: () => this.destination }));
}

describe("CloudTableTalkVoiceOutput prerecorded playback", () => {
  beforeEach(() => {
    vi.stubGlobal("window", { AudioContext: MockAudioContext });
    vi.stubGlobal("document", { baseURI: "https://example.test/cribbage/" });
  });

  afterEach(() => vi.unstubAllGlobals());

  it("skips a line missing from the manifest without requesting live TTS", async () => {
    const fetcher = vi.fn(async () => new Response(JSON.stringify({}), { status: 200 }));
    const output = new CloudTableTalkVoiceOutput({ enabled: true, fetcher: fetcher as typeof fetch });

    await expect(output.speak(line)).resolves.toBe(false);
    expect(fetcher).toHaveBeenCalledTimes(1);
  });

  it("skips a line when its manifest clip cannot be loaded", async () => {
    const fetcher = vi.fn()
      .mockResolvedValueOnce(new Response(JSON.stringify({
        [`${line.characterId}|${line.text}`]: "table-talk-voice/arthur-test.webm",
      }), { status: 200 }))
      .mockResolvedValueOnce(new Response(null, { status: 404 }));
    const output = new CloudTableTalkVoiceOutput({ enabled: true, fetcher: fetcher as typeof fetch });

    await expect(output.speak(line)).resolves.toBe(false);
    expect(fetcher).toHaveBeenCalledTimes(2);
  });

  it("loads, decodes, and plays a manifest clip", async () => {
    const fetcher = vi.fn()
      .mockResolvedValueOnce(new Response(JSON.stringify({
        [`${line.characterId}|${line.text}`]: "table-talk-voice/arthur-test.webm",
      }), { status: 200 }))
      .mockResolvedValueOnce(new Response(new Uint8Array([1, 2, 3]), { status: 200 }));
    const onPlaybackStart = vi.fn();
    const output = new CloudTableTalkVoiceOutput({ enabled: true, fetcher: fetcher as typeof fetch });

    await expect(output.speak(line, onPlaybackStart)).resolves.toBe(true);
    expect(onPlaybackStart).toHaveBeenCalledOnce();
    expect(fetcher).toHaveBeenCalledTimes(2);
  });

  it("returns false when a prerecorded clip cannot be decoded", async () => {
    const context = new MockAudioContext();
    context.decodeAudioData.mockRejectedValueOnce(new Error("decode failed"));
    vi.stubGlobal("window", { AudioContext: class { constructor() { return context; } } });
    const fetcher = vi.fn()
      .mockResolvedValueOnce(new Response(JSON.stringify({
        [`${line.characterId}|${line.text}`]: "table-talk-voice/arthur-test.webm",
      }), { status: 200 }))
      .mockResolvedValueOnce(new Response(new Uint8Array([1]), { status: 200 }));
    const output = new CloudTableTalkVoiceOutput({ enabled: true, fetcher: fetcher as typeof fetch });

    await expect(output.speak(line)).resolves.toBe(false);
  });

  it("cancels active prerecorded playback", async () => {
    const context = new MockAudioContext();
    context.source.start = vi.fn();
    vi.stubGlobal("window", { AudioContext: class { constructor() { return context; } } });
    const fetcher = vi.fn()
      .mockResolvedValueOnce(new Response(JSON.stringify({
        [`${line.characterId}|${line.text}`]: "table-talk-voice/arthur-test.webm",
      }), { status: 200 }))
      .mockResolvedValueOnce(new Response(new Uint8Array([1]), { status: 200 }));
    const output = new CloudTableTalkVoiceOutput({ enabled: true, fetcher: fetcher as typeof fetch });

    const speaking = output.speak(line);
    await vi.waitFor(() => expect(context.source.start).toHaveBeenCalled());
    output.cancel();

    await expect(speaking).resolves.toBe(true);
  });
});
