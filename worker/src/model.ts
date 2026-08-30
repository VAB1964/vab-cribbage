export type RoomStatus = "lobby" | "playing" | "counting" | "complete";
export type GamePhase = "lobby" | "cut" | "discard" | "pegging" | "counting" | "dealComplete" | "complete";
export type TeamId = "gold" | "green";

export interface Player {
  id: string;
  name: string;
  avatarId: string;
  seat: number | null;
  teamId: TeamId | null;
  connected: boolean;
  ready: boolean;
  isAI: boolean;
  aiDifficulty: "easy" | "medium" | "hard" | null;
  reconnectTokenHash: string | null;
  replacedPermanently: boolean;
  joinedAt: number;
}

export interface GameState {
  phase: GamePhase;
  dealerSeat: number | null;
  turnSeat: number | null;
  teamScores: Record<string, number>;
  starterCard: string | null;
  runningCount: number;
  lastPegger: string | null;
  hands: Record<string, string[]>;
  countHands: Record<string, string[]>;
  deck: string[];
  crib: string[];
  playedCards: { playerId: string; card: string }[];
  acknowledgements: string[];
  cutCards: Record<string, string>;
  goPlayers: string[];
  sequenceCards: { playerId: string; card: string }[];
  countQueue: { eventId: string; playerId: string | null; teamId: string; kind: "hand" | "crib"; points: number }[];
  countIndex: number;
  pendingEventId: string | null;
  dealNumber: number;
  winnerTeamId: string | null;
  result: "normal" | "skunk" | "double-skunk" | null;
  pausedForPlayerId: string | null;
}

export interface LedgerEntry {
  id: string;
  gameNumber: number;
  players: { playerId: string; name: string; teamId: string }[];
  teams: { teamId: string; memberPlayerIds: string[] }[];
  finalTeamScores: Record<string, number>;
  winnerTeamId: string;
  holesBehind: Record<string, number>;
  result: "normal" | "skunk" | "double-skunk";
  multiplier: 1 | 2 | 4;
  baseGameCents: number;
  perHoleCents: 5 | 10 | 15 | 20;
  perPlayerCents: Record<string, number>;
  timestamp: number;
}

export interface SessionLedger {
  enabled: boolean;
  baseStakeCents: number;
  perHoleCents: 5 | 10 | 15 | 20;
  entries: LedgerEntry[];
}

export interface RoomState {
  roomId: string;
  revision: number;
  status: RoomStatus;
  createdAt: number;
  hostPlayerId: string;
  seatCount: 2 | 3 | 4;
  settingsVersion: number;
  players: Player[];
  game: GameState;
  ledger: SessionLedger;
  rematchRequests: string[];
  dialogue: { id: string; type: string; playerId?: string; data?: {
    card?: string; reason?: string; runningCount?: number; points?: number; score?: number; nextPlayerId?: string; message?: string;
  }; createdAt: number }[];
  lastActivityAt: number;
  expiresAt: number;
}

export interface PlayerView {
  roomId: string;
  revision: number;
  status: RoomStatus;
  hostPlayerId: string;
  seatCount: number;
  settingsVersion: number;
  players: Omit<Player, "reconnectTokenHash">[];
  game: Omit<GameState, "hands" | "countHands" | "deck" | "crib" | "countQueue"> & {
    hand: string[];
    handCounts: Record<string, number>;
    cribCount: number;
    crib: string[] | null;
    currentCount: (GameState["countQueue"][number] & { cards: string[]; starterCard: string }) | null;
  };
  ledger: SessionLedger;
  rematchRequests: string[];
  dialogue: RoomState["dialogue"];
  expiresAt: number;
}

export function initialGame(): GameState {
  return {
    phase: "lobby", dealerSeat: null, turnSeat: null, teamScores: {},
    starterCard: null, runningCount: 0, lastPegger: null, hands: {}, countHands: {}, deck: [], crib: [],
    playedCards: [], acknowledgements: [], cutCards: {}, goPlayers: [], sequenceCards: [],
    countQueue: [], countIndex: 0, pendingEventId: null, dealNumber: 0,
    winnerTeamId: null, result: null, pausedForPlayerId: null,
  };
}

export function playerView(state: RoomState, playerId: string | null): PlayerView {
  const handCounts = Object.fromEntries(Object.entries(state.game.hands).map(([id, hand]) => [id, hand.length]));
  const players = state.players.map(({ reconnectTokenHash: _secret, ...player }) => player);
  const { hands: _hands, countHands: _countHands, deck: _deck, crib: _crib, countQueue: _countQueue, ...publicGame } = state.game;
  const cribIsBeingCounted = state.game.phase === "counting"
    && state.game.countQueue[state.game.countIndex]?.kind === "crib";
  return {
    roomId: state.roomId,
    revision: state.revision,
    status: state.status,
    hostPlayerId: state.hostPlayerId,
    seatCount: state.seatCount,
    settingsVersion: state.settingsVersion,
    players,
    game: {
      ...publicGame,
      hand: playerId === null ? [] : [...(state.game.hands[playerId] ?? [])],
      handCounts,
      cribCount: state.game.crib.length,
      crib: cribIsBeingCounted || state.game.phase === "complete" ? [...state.game.crib] : null,
      currentCount: state.game.countQueue[state.game.countIndex]
        ? {
          ...state.game.countQueue[state.game.countIndex]!,
          cards: state.game.countQueue[state.game.countIndex]!.kind === "crib"
            ? [...state.game.crib]
            : [...(state.game.countHands[state.game.countQueue[state.game.countIndex]!.playerId ?? ""] ?? [])],
          starterCard: state.game.starterCard!,
        }
        : null,
    },
    ledger: structuredClone(state.ledger),
    rematchRequests: [...state.rematchRequests],
    dialogue: state.dialogue.map((event) => ({ ...event })),
    expiresAt: state.expiresAt,
  };
}
