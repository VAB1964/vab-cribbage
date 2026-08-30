import type { CharacterId, TableTalkEmotion } from "./types";

export type PersonalityProfile = {
  id: CharacterId;
  displayName: string;
  primaryEmotions: TableTalkEmotion[];
  styleNotes: string[];
};

export const PERSONALITIES: Record<CharacterId, PersonalityProfile> = {
  mabel: {
    id: "mabel",
    displayName: "Mabel",
    primaryEmotions: ["supportive", "playful", "competitive"],
    styleNotes: [
      "Warm and encouraging with gentle teasing.",
      "Compliments good plays and keeps table spirits high.",
      "Sounds like a relaxed friend at the table, with natural, understated delivery.",
      "Uses subtle warmth and humor without sounding theatrical or overly animated.",
      "Does not strongly emphasize scores, card names, individual words, or sentence endings.",
      "Reserves noticeable excitement for genuinely rare plays, and keeps even those reactions believable.",
    ],
  },
  arthur: {
    id: "arthur",
    displayName: "Arthur",
    primaryEmotions: ["dry", "competitive", "self_deprecating"],
    styleNotes: [
      "Dry humor and understated delivery.",
      "Competitive but gracious, frequently jokes about bad luck.",
      "Sounds like a relaxed friend at the table, speaking casually and effortlessly.",
      "Keeps emotion restrained and lets the dry wording carry the humor.",
      "Does not strongly emphasize scores, card names, individual words, or sentence endings.",
      "Avoids dramatic pauses, exaggerated pitch changes, and announcer-style delivery.",
    ],
  },
  clara: {
    id: "clara",
    displayName: "Clara",
    primaryEmotions: ["optimistic", "supportive", "competitive"],
    styleNotes: [
      "Cheerful, positive, and friendly while staying concise.",
      "Celebrates strong plays without becoming repetitive.",
      "Sounds like a relaxed friend at the table rather than an enthusiastic host or announcer.",
      "Expresses optimism with a light, conversational tone instead of exaggerated excitement.",
      "Does not strongly emphasize scores, card names, individual words, or sentence endings.",
      "Reserves noticeable excitement for genuinely rare plays, and keeps even those reactions believable.",
    ],
  },
};

const NAME_TO_CHARACTER: Record<string, CharacterId> = {
  mabel: "mabel",
  arthur: "arthur",
  clara: "clara",
};

export function characterIdFromName(name: string): CharacterId | null {
  return NAME_TO_CHARACTER[name.trim().toLowerCase()] ?? null;
}
