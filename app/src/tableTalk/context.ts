import { characterIdFromName } from "./personalities";
import type {
  CardSuit,
  PublicCard,
  PublicScore,
  TableTalkContext,
  TableTalkLevel,
  TableTalkParticipant,
} from "./types";

export type PublicPlayerSnapshot = {
  name: string;
  color: string;
  score: number;
  team: number;
};

export function toPublicCard(card: { rank: number; suit: CardSuit }): PublicCard {
  return { rank: card.rank, suit: card.suit };
}

export function buildPublicScores(
  players: PublicPlayerSnapshot[],
  playerCount: number,
): PublicScore[] {
  return players.slice(0, playerCount).map((player, playerIndex) => ({
    playerIndex,
    team: player.team,
    name: player.name,
    score: player.score,
  }));
}

export function buildTableTalkParticipants(
  players: PublicPlayerSnapshot[],
  playerCount: number,
): TableTalkParticipant[] {
  return players
    .slice(1, playerCount)
    .map((player, playerIndexOffset) => {
      const playerIndex = playerIndexOffset + 1;
      const characterId = characterIdFromName(player.name);
      if (!characterId) return null;
      return {
        playerIndex,
        team: player.team,
        name: player.name,
        color: player.color,
        characterId,
      };
    })
    .filter((entry): entry is TableTalkParticipant => entry !== null);
}

export function buildTableTalkContext(args: {
  level: TableTalkLevel;
  players: PublicPlayerSnapshot[];
  playerCount: number;
  dealerIndex: number;
  runningCount: number;
}): TableTalkContext {
  const { level, players, playerCount, dealerIndex, runningCount } = args;
  return {
    level,
    playerCount,
    dealerIndex,
    runningCount,
    scores: buildPublicScores(players, playerCount),
    participants: buildTableTalkParticipants(players, playerCount),
  };
}
