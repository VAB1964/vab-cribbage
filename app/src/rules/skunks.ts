export type GameResultClass = "normal" | "skunk" | "doubleSkunk";
export interface SkunkRules { readonly targetScore: number; readonly skunkLine: number; readonly doubleSkunkLine: number }
export const STANDARD_SKUNK_RULES: SkunkRules = { targetScore: 121, skunkLine: 91, doubleSkunkLine: 61 };

export function classifyLoss(loserScore: number, rules: SkunkRules = STANDARD_SKUNK_RULES): GameResultClass {
  if (!Number.isInteger(loserScore) || loserScore < 0 || loserScore >= rules.targetScore)
    throw new RangeError("Loser score must be a non-negative integer below the target");
  if (loserScore < rules.doubleSkunkLine) return "doubleSkunk";
  if (loserScore < rules.skunkLine) return "skunk";
  return "normal";
}

export const skunkMultiplier = (result: GameResultClass): 1 | 2 | 4 =>
  result === "normal" ? 1 : result === "skunk" ? 2 : 4;
