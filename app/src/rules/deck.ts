import { card, SUITS, type Card } from "./cards";

export type RandomSource = () => number;

export const createDeck = (): Card[] =>
  SUITS.flatMap(suit => Array.from({ length: 13 }, (_, index) => card((index + 1) as Card["rank"], suit)));

/** Returns a shuffled copy. RNG values must be in [0, 1). */
export function shuffle<T>(items: readonly T[], random: RandomSource): T[] {
  const result = [...items];
  for (let index = result.length - 1; index > 0; index--) {
    const sample = random();
    if (!Number.isFinite(sample) || sample < 0 || sample >= 1) throw new RangeError("RNG must return a value in [0, 1)");
    const swapIndex = Math.floor(sample * (index + 1));
    [result[index], result[swapIndex]] = [result[swapIndex], result[index]];
  }
  return result;
}
