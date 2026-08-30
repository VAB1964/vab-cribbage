export const SUITS = ["clubs", "diamonds", "hearts", "spades"] as const;
export type Suit = (typeof SUITS)[number];
export type Rank = 1 | 2 | 3 | 4 | 5 | 6 | 7 | 8 | 9 | 10 | 11 | 12 | 13;
export interface Card { readonly rank: Rank; readonly suit: Suit; readonly id: string }

export const card = (rank: Rank, suit: Suit): Card => ({ rank, suit, id: `${rank}-${suit}` });
export const cardValue = ({ rank }: Card): number => Math.min(rank, 10);
export const isCard = (value: unknown): value is Card => {
  if (!value || typeof value !== "object") return false;
  const candidate = value as Partial<Card>;
  return Number.isInteger(candidate.rank) && candidate.rank! >= 1 && candidate.rank! <= 13
    && SUITS.includes(candidate.suit as Suit) && candidate.id === `${candidate.rank}-${candidate.suit}`;
};
