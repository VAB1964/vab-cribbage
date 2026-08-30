export type PlayerCount = 2 | 3 | 4;
export interface DealPlan {
  readonly playerCount: PlayerCount;
  readonly cardsPerPlayer: number;
  readonly discardsPerPlayer: number;
  readonly kittyCards: number;
  readonly cribSize: 4;
}

export function dealPlan(playerCount: PlayerCount): DealPlan {
  if (playerCount === 2) return { playerCount, cardsPerPlayer: 6, discardsPerPlayer: 2, kittyCards: 0, cribSize: 4 };
  if (playerCount === 3) return { playerCount, cardsPerPlayer: 5, discardsPerPlayer: 1, kittyCards: 1, cribSize: 4 };
  return { playerCount, cardsPerPlayer: 5, discardsPerPlayer: 1, kittyCards: 0, cribSize: 4 };
}

export const nextDealerSeat = (dealerSeat: number, playerCount: PlayerCount): number => (dealerSeat + 1) % playerCount;
