import type { TableTalkLevel } from "../tableTalk/types";

export type AvatarCategory = "male" | "female" | "generic";
export type Avatar = { id: string; label: string; src: string; category: AvatarCategory };

const AVATAR_DIR = `${import.meta.env.BASE_URL}cribbage_avatars/web-256`;

export const AVATARS: readonly Avatar[] = [
  { id: "m-1", label: "Silver gentleman", src: `${AVATAR_DIR}/avatar_male_01.png`, category: "male" },
  { id: "m-2", label: "Bearded gentleman", src: `${AVATAR_DIR}/avatar_male_02.png`, category: "male" },
  { id: "m-3", label: "Gentleman with glasses", src: `${AVATAR_DIR}/avatar_male_03.png`, category: "male" },
  { id: "m-4", label: "Smiling gentleman", src: `${AVATAR_DIR}/avatar_male_04.png`, category: "male" },
  { id: "f-1", label: "Lady with curls", src: `${AVATAR_DIR}/avatar_female_01.png`, category: "female" },
  { id: "f-2", label: "Lady with bob", src: `${AVATAR_DIR}/avatar_female_02.png`, category: "female" },
  { id: "f-3", label: "Lady with auburn hair", src: `${AVATAR_DIR}/avatar_female_03.png`, category: "female" },
  { id: "f-4", label: "Lady with glasses", src: `${AVATAR_DIR}/avatar_female_04.png`, category: "female" },
  { id: "g-1", label: "Fox", src: `${AVATAR_DIR}/avatar_generic_fox.png`, category: "generic" },
  { id: "g-2", label: "Owl", src: `${AVATAR_DIR}/avatar_generic_owl.png`, category: "generic" },
  { id: "g-3", label: "Dog", src: `${AVATAR_DIR}/avatar_generic_dog.png`, category: "generic" },
  { id: "g-4", label: "Cat", src: `${AVATAR_DIR}/avatar_generic_cat.png`, category: "generic" },
] as const;

export function avatarById(id?: string | null) {
  return AVATARS.find(avatar => avatar.id === id);
}

export type PlayerPreferences = {
  displayName: string;
  avatarId: string;
  soundEnabled: boolean;
  volume: number;
  tableTalk: TableTalkLevel;
  voiceEnabled: boolean;
  reducedAnimation: boolean;
};

const STORAGE_KEY = "cribbage.player-preferences.v1";
export const DEFAULT_PREFERENCES: PlayerPreferences = {
  displayName: "",
  avatarId: AVATARS[0].id,
  soundEnabled: true,
  volume: 0.55,
  tableTalk: "occasional",
  voiceEnabled: false,
  reducedAnimation: false,
};

export function loadPreferences(): PlayerPreferences {
  try {
    const value = JSON.parse(localStorage.getItem(STORAGE_KEY) ?? "{}") as Partial<PlayerPreferences>;
    return {
      ...DEFAULT_PREFERENCES,
      ...value,
      avatarId: AVATARS.some(avatar => avatar.id === value.avatarId) ? value.avatarId! : DEFAULT_PREFERENCES.avatarId,
      volume: Math.max(0, Math.min(1, Number(value.volume ?? DEFAULT_PREFERENCES.volume))),
    };
  } catch {
    return DEFAULT_PREFERENCES;
  }
}

export function savePreferences(preferences: PlayerPreferences) {
  localStorage.setItem(STORAGE_KEY, JSON.stringify(preferences));
}
