import { DIALOGUE_LIBRARY, type DialogueKey } from "../tableTalk/dialogueLibrary";
import type { CharacterId } from "../tableTalk/types";

let manifestPromise: Promise<Record<string, string>> | null = null;
let activeAudio: HTMLAudioElement | null = null;

function manifest() {
  manifestPromise ??= fetch(new URL("table-talk-voice/manifest.json", document.baseURI))
    .then(response => response.ok ? response.json() as Promise<Record<string, string>> : {})
    .catch(() => ({}));
  return manifestPromise;
}

export async function playScriptedDialogue(characterId: CharacterId, key: DialogueKey, volume: number): Promise<string | null> {
  const clips = await manifest();
  const pool = DIALOGUE_LIBRARY[characterId][key];
  if (!pool) return null;
  const available = pool.lines.filter(line => clips[`${characterId}|${line}`]);
  if (!available.length) return null;
  const line = available[Math.floor(Math.random() * available.length)]!;
  activeAudio?.pause();
  activeAudio = new Audio(new URL(clips[`${characterId}|${line}`]!, document.baseURI).href);
  activeAudio.volume = Math.max(0, Math.min(1, volume));
  try {
    await activeAudio.play();
    return line;
  } catch {
    return null;
  }
}
