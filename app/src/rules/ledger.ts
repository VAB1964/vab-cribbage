import { skunkMultiplier, type GameResultClass } from "./skunks";

export interface StakesConfig { readonly gameCents: number; readonly perHoleCents: 5 | 10 | 15 | 20; readonly maximumGameCents: number }
export interface SettlementInput {
  readonly gameNumber: number; readonly winnerIds: readonly string[]; readonly loserIds: readonly string[];
  readonly winnerScore: number; readonly loserScore: number; readonly result: GameResultClass;
  readonly stakes: StakesConfig; readonly timestamp: string;
}
export interface LedgerEntry extends SettlementInput {
  readonly holesBehind: number; readonly amountPerLoserCents: number;
  readonly amountsCents: Readonly<Record<string, number>>;
}

const integer = (value: number, name: string) => {
  if (!Number.isSafeInteger(value) || value < 0) throw new RangeError(`${name} must be a non-negative safe integer`);
};

export function settleGame(input: SettlementInput): LedgerEntry {
  integer(input.stakes.gameCents, "Game amount");
  integer(input.stakes.maximumGameCents, "Maximum game amount");
  if (input.stakes.gameCents > input.stakes.maximumGameCents) throw new RangeError("Game amount exceeds configured maximum");
  if (![5, 10, 15, 20].includes(input.stakes.perHoleCents)) throw new RangeError("Unsupported per-hole amount");
  if (!input.winnerIds.length || !input.loserIds.length)
    throw new RangeError("Winning and losing sides must be non-empty");
  if (new Set([...input.winnerIds, ...input.loserIds]).size !== input.winnerIds.length + input.loserIds.length)
    throw new RangeError("Player IDs must be unique");
  const holesBehind = Math.max(0, 121 - input.loserScore);
  const amountPerLoserCents = (input.stakes.gameCents + holesBehind * input.stakes.perHoleCents) * skunkMultiplier(input.result);
  const amountsCents: Record<string, number> = {};
  input.loserIds.forEach(id => amountsCents[id] = -amountPerLoserCents);
  const totalOwed = amountPerLoserCents * input.loserIds.length;
  if (totalOwed % input.winnerIds.length !== 0)
    throw new RangeError("Settlement cannot be divided equally among winners in integer cents");
  input.winnerIds.forEach(id => amountsCents[id] = totalOwed / input.winnerIds.length);
  return Object.freeze({ ...input, winnerIds: Object.freeze([...input.winnerIds]), loserIds: Object.freeze([...input.loserIds]),
    holesBehind, amountPerLoserCents, amountsCents: Object.freeze(amountsCents) });
}

export function ledgerTotals(entries: readonly LedgerEntry[]): Record<string, number> {
  const totals: Record<string, number> = {};
  for (const entry of entries)
    for (const [id, amount] of Object.entries(entry.amountsCents)) totals[id] = (totals[id] ?? 0) + amount;
  return totals;
}
