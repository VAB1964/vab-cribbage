export type TeamId = string;
export interface TeamState {
  readonly id: TeamId;
  readonly memberSeats: readonly number[];
  readonly score: number;
}

export function createTeams(playerCount: 2 | 3 | 4): TeamState[] {
  return playerCount === 4
    ? [{ id: "team-0", memberSeats: [0, 2], score: 0 }, { id: "team-1", memberSeats: [1, 3], score: 0 }]
    : Array.from({ length: playerCount }, (_, seat) => ({ id: `team-${seat}`, memberSeats: [seat], score: 0 }));
}

export function teamForSeat(teams: readonly TeamState[], seat: number): TeamState {
  const team = teams.find(candidate => candidate.memberSeats.includes(seat));
  if (!team) throw new RangeError(`No team for seat ${seat}`);
  return team;
}

export function addTeamScore(teams: readonly TeamState[], teamId: TeamId, points: number, target = 121): TeamState[] {
  if (!Number.isInteger(points) || points < 0) throw new RangeError("Points must be a non-negative integer");
  if (!teams.some(team => team.id === teamId)) throw new RangeError(`Unknown team ${teamId}`);
  return teams.map(team => team.id === teamId ? { ...team, score: Math.min(target, team.score + points) } : team);
}

export const winningTeam = (teams: readonly TeamState[], target = 121): TeamState | undefined =>
  teams.find(team => team.score >= target);
