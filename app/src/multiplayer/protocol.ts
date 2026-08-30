export const PROTOCOL_VERSION = 1;

export type CommandType =
  | "CREATE_ROOM" | "JOIN_ROOM" | "LEAVE_ROOM" | "SET_READY" | "UPDATE_SETUP"
  | "UPDATE_IDENTITY" | "ASSIGN_SEAT" | "ASSIGN_TEAM"
  | "ADD_AI" | "REMOVE_AI" | "REPLACE_WITH_AI" | "START_GAME" | "CUT_CARD"
  | "DISCARD" | "PLAY_CARD" | "SAY_GO" | "ACK_COUNT" | "NEXT_DEAL"
  | "UPDATE_LEDGER" | "REQUEST_REMATCH" | "REMATCH" | "WAIT_FOR_PLAYER"
  | "END_GAME" | "LEAVE_SESSION";

export type CommandEnvelope<T = unknown> = {
  protocolVersion: typeof PROTOCOL_VERSION;
  roomId: string;
  playerId: string | null;
  commandId: string;
  expectedRevision: number;
  type: CommandType;
  payload: T;
};

export type ConnectionState = "idle" | "connecting" | "connected" | "reconnecting" | "offline";

export function createCommand<T>(
  type: CommandType,
  payload: T,
  context: { roomId: string; playerId: string | null; expectedRevision: number },
): CommandEnvelope<T> {
  return {
    protocolVersion: PROTOCOL_VERSION,
    commandId: crypto.randomUUID(),
    ...context,
    type,
    payload,
  };
}
