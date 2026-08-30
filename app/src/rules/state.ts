import type { Card } from "./cards";
import type { PlayerCount } from "./dealing";
import { addTeamScore, teamForSeat, winningTeam, type TeamState } from "./teams";

export type GamePhase = "cut" | "discard" | "pegging" | "counting" | "complete";
export interface DeterministicGameState {
  readonly revision: number; readonly phase: GamePhase; readonly playerCount: PlayerCount;
  readonly dealerSeat: number; readonly turnSeat: number; readonly teams: readonly TeamState[];
  readonly runningCount: number; readonly sequence: readonly Card[]; readonly lastPeggerSeat?: number;
  readonly winnerTeamId?: string;
}
export type GameTransition =
  | { readonly type: "setPhase"; readonly phase: GamePhase; readonly turnSeat: number }
  | { readonly type: "play"; readonly seat: number; readonly card: Card }
  | { readonly type: "resetPeggingSequence"; readonly nextSeat: number }
  | { readonly type: "score"; readonly seat: number; readonly points: number };

const advance = (state: DeterministicGameState, update: Partial<DeterministicGameState>): DeterministicGameState =>
  ({ ...state, ...update, revision: state.revision + 1 });

export function transition(state: DeterministicGameState, action: GameTransition): DeterministicGameState {
  if (state.phase === "complete") throw new Error("Game is complete");
  if (action.type === "setPhase") return advance(state, { phase: action.phase, turnSeat: action.turnSeat });
  if (action.type === "resetPeggingSequence")
    return advance(state, { runningCount: 0, sequence: [], turnSeat: action.nextSeat });
  if (action.type === "play") {
    if (state.phase !== "pegging" || action.seat !== state.turnSeat) throw new Error("Illegal play transition");
    return advance(state, { runningCount: state.runningCount + Math.min(action.card.rank, 10),
      sequence: [...state.sequence, action.card], lastPeggerSeat: action.seat,
      turnSeat: (action.seat + 1) % state.playerCount });
  }
  const team = teamForSeat(state.teams, action.seat);
  const teams = addTeamScore(state.teams, team.id, action.points);
  const winner = winningTeam(teams);
  return advance(state, { teams, winnerTeamId: winner?.id, phase: winner ? "complete" : state.phase });
}
