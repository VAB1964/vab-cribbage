import { cardValue, type Card } from "./cards";

export type PeggingScoreKind = "fifteen" | "thirtyOne" | "pair" | "triple" | "quad" | "run" | "go" | "lastCard";
export interface PeggingScore { readonly kind: PeggingScoreKind; readonly points: number }

export const canPlay = (card: Card, runningCount: number): boolean => runningCount + cardValue(card) <= 31;
export const legalCards = (hand: readonly Card[], runningCount: number): Card[] => hand.filter(item => canPlay(item, runningCount));
export const legalPeggingActions = (hand: readonly Card[], runningCount: number): Readonly<
  { type: "play"; card: Card } | { type: "go" }
>[] => {
  const cards = legalCards(hand, runningCount);
  return cards.length ? cards.map(card => ({ type: "play" as const, card })) : [{ type: "go" }];
};

export function scorePeggingPlay(sequence: readonly Card[], played: Card, runningCount: number): PeggingScore[] {
  if (!canPlay(played, runningCount)) throw new RangeError("Card would exceed 31");
  const cards = [...sequence, played];
  const total = runningCount + cardValue(played);
  const scores: PeggingScore[] = [];
  if (total === 15) scores.push({ kind: "fifteen", points: 2 });
  if (total === 31) scores.push({ kind: "thirtyOne", points: 2 });
  let same = 1;
  for (let index = cards.length - 2; index >= 0 && cards[index].rank === played.rank; index--) same++;
  if (same >= 2) scores.push({ kind: same === 2 ? "pair" : same === 3 ? "triple" : "quad", points: same === 2 ? 2 : same === 3 ? 6 : 12 });
  for (let length = Math.min(7, cards.length); length >= 3; length--) {
    const ranks = cards.slice(-length).map(card => card.rank).sort((a, b) => a - b);
    if (new Set(ranks).size === length && ranks[length - 1] - ranks[0] === length - 1) {
      scores.push({ kind: "run", points: length }); break;
    }
  }
  return scores;
}

export const scoreSequenceEnd = (runningCount: number, isFinalCard: boolean): PeggingScore =>
  ({ kind: isFinalCard ? "lastCard" : "go", points: runningCount === 31 ? 0 : 1 });
