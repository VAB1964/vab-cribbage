export type TableTalkLevel = "off" | "occasional" | "chatty";

export type CharacterId = "mabel" | "arthur" | "clara";
export type TableTalkEmotion =
  | "supportive"
  | "playful"
  | "dry"
  | "optimistic"
  | "competitive"
  | "concerned"
  | "self_deprecating";

export type CardSuit = "♠" | "♥" | "♦" | "♣";
export type PublicCard = { rank: number; suit: CardSuit };

export type PeggingKind =
  | "fifteen"
  | "thirty_one"
  | "pair"
  | "pair_royal"
  | "double_pair_royal"
  | "pegging_run";

export type TableTalkEvent =
  | { type: "game_started" }
  | { type: "first_crib_won"; dealerIndex: number }
  | { type: "round_started"; dealerIndex: number; roundNumber: number }
  | { type: "card_played"; actorIndex: number; card: PublicCard; runningTotal: number }
  | { type: "pegging_scored"; actorIndex: number; points: number; kind: PeggingKind; runningTotal: number }
  | { type: "go_declared"; actorIndex: number }
  | { type: "last_card_scored"; actorIndex: number; points: 1 }
  | { type: "hand_revealed"; actorIndex: number; points: number }
  | { type: "large_hand_scored"; actorIndex: number; points: number }
  | { type: "zero_point_hand"; actorIndex: number }
  | { type: "crib_revealed"; ownerIndex: number }
  | { type: "large_crib_scored"; ownerIndex: number; points: number }
  | { type: "lead_changed"; newLeaderTeam: number }
  | { type: "player_close_to_winning"; actorIndex: number; score: number }
  | { type: "opponent_close_to_winning"; actorIndex: number; score: number }
  | { type: "computer_falls_well_behind"; actorIndex: number; deficit: number }
  | { type: "computer_catches_up"; actorIndex: number; deficit: number }
  | { type: "game_won"; winnerIndex: number; winnerTeam: number }
  | { type: "game_lost"; loserIndex: number; winnerTeam: number };

export type TableTalkEventType = TableTalkEvent["type"];

export type TableTalkParticipant = {
  playerIndex: number;
  team: number;
  name: string;
  color: string;
  characterId: CharacterId;
};

export type PublicScore = {
  playerIndex: number;
  team: number;
  name: string;
  score: number;
};

export type TableTalkContext = {
  level: TableTalkLevel;
  playerCount: number;
  dealerIndex: number;
  runningCount: number;
  scores: PublicScore[];
  participants: TableTalkParticipant[];
};

export type CharacterDialogueEmission = {
  characterId: CharacterId;
  characterName: string;
  text: string;
  eventType: TableTalkEventType;
  emotion: TableTalkEmotion;
  timestamp: number;
  event: TableTalkEvent;
  context: TableTalkContext;
};
