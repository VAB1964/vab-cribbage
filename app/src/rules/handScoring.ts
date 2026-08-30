import { cardValue, type Card } from "./cards";

export type HandScoreCategory = "fifteen" | "pair" | "run" | "flush" | "nobs";
export interface HandScoreEvent {
  readonly category: HandScoreCategory;
  readonly points: number;
  readonly cards: readonly Card[];
}
export interface HandScore {
  readonly fifteens: number; readonly pairs: number; readonly runs: number;
  readonly flush: number; readonly nobs: number; readonly total: number;
  readonly events: readonly HandScoreEvent[];
}

function subsets(cards: readonly Card[]): Card[][] {
  const result: Card[][] = [];
  for (let mask = 1; mask < 1 << cards.length; mask++)
    result.push(cards.filter((_, index) => Boolean(mask & (1 << index))));
  return result;
}

export function scoreHand(hand: readonly Card[], starter: Card, isCrib = false): HandScore {
  if (hand.length !== 4) throw new RangeError("A counted hand must contain four cards");
  const all = [...hand, starter];
  const events: HandScoreEvent[] = [];
  for (const group of subsets(all))
    if (group.reduce((sum, item) => sum + cardValue(item), 0) === 15)
      events.push({ category: "fifteen", points: 2, cards: group });
  for (let left = 0; left < all.length; left++)
    for (let right = left + 1; right < all.length; right++)
      if (all[left].rank === all[right].rank)
        events.push({ category: "pair", points: 2, cards: [all[left], all[right]] });
  for (let length = 5; length >= 3; length--) {
    const runs = subsets(all).filter(group => {
      if (group.length !== length) return false;
      const ranks = group.map(item => item.rank).sort((a, b) => a - b);
      return new Set(ranks).size === length && ranks[length - 1] - ranks[0] === length - 1;
    });
    if (runs.length) {
      events.push(...runs.map(cards => ({ category: "run" as const, points: length, cards })));
      break;
    }
  }
  const sameSuit = hand.every(item => item.suit === hand[0].suit);
  if (sameSuit && starter.suit === hand[0].suit)
    events.push({ category: "flush", points: 5, cards: all });
  else if (sameSuit && !isCrib)
    events.push({ category: "flush", points: 4, cards: hand });
  const jack = hand.find(item => item.rank === 11 && item.suit === starter.suit);
  if (jack) events.push({ category: "nobs", points: 1, cards: [jack, starter] });
  const sum = (category: HandScoreCategory) => events.filter(event => event.category === category)
    .reduce((total, event) => total + event.points, 0);
  const fifteens = sum("fifteen"), pairs = sum("pair"), runs = sum("run"), flush = sum("flush"), nobs = sum("nobs");
  return { fifteens, pairs, runs, flush, nobs, total: fifteens + pairs + runs + flush + nobs, events };
}

export const scoreHeels = (starter: Card): number => starter.rank === 11 ? 2 : 0;
