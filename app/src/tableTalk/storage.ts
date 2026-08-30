import type { TableTalkLevel } from "./types";

const TABLE_TALK_KEY = "cribbage_tableTalkLevel";
const TABLE_TALK_VOICE_ENABLED_KEY = "cribbage_tableTalkVoiceEnabled";

const LEVELS: TableTalkLevel[] = ["off", "occasional", "chatty"];

export function loadTableTalkLevel(defaultLevel: TableTalkLevel = "occasional"): TableTalkLevel {
  try {
    const saved = localStorage.getItem(TABLE_TALK_KEY);
    if (!saved) return defaultLevel;
    return LEVELS.includes(saved as TableTalkLevel) ? (saved as TableTalkLevel) : defaultLevel;
  } catch {
    return defaultLevel;
  }
}

export function saveTableTalkLevel(level: TableTalkLevel) {
  try {
    localStorage.setItem(TABLE_TALK_KEY, level);
  } catch {
    // Ignore storage failures to avoid blocking gameplay.
  }
}

export function loadTableTalkVoiceEnabled(defaultEnabled = false): boolean {
  try {
    const saved = localStorage.getItem(TABLE_TALK_VOICE_ENABLED_KEY);
    if (saved === null) return defaultEnabled;
    return saved === "true";
  } catch {
    return defaultEnabled;
  }
}

export function saveTableTalkVoiceEnabled(enabled: boolean) {
  try {
    localStorage.setItem(TABLE_TALK_VOICE_ENABLED_KEY, String(enabled));
  } catch {
    // Ignore storage failures to avoid blocking gameplay.
  }
}
