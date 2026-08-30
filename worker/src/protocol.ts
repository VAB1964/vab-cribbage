import { z } from "zod";

export const PROTOCOL_VERSION = 1;
export const MAX_MESSAGE_BYTES = 16_384;
export const ROOM_CODE = /^[A-HJ-NP-Z2-9]{6}$/;

const card = z.string().regex(/^(A|[2-9]|10|J|Q|K)[CDHS]$/);
const identity = z.object({
  name: z.string().trim().min(1).max(24),
  avatarId: z.string().regex(/^(?:m|f|g)-[1-4]$/),
}).strict();

const payloads = {
  CREATE_ROOM: identity.extend({ seatCount: z.union([z.literal(2), z.literal(3), z.literal(4)]).default(2) }).strict(),
  JOIN_ROOM: identity.extend({ reconnectToken: z.string().min(32).max(256).optional() }).strict(),
  SET_READY: z.object({ ready: z.boolean() }).strict(),
  UPDATE_IDENTITY: identity,
  ASSIGN_SEAT: z.object({ targetPlayerId: z.string().uuid(), seat: z.number().int().min(0).max(3).nullable() }).strict(),
  ASSIGN_TEAM: z.object({ targetPlayerId: z.string().uuid(), teamId: z.enum(["gold", "green"]).nullable() }).strict(),
  UPDATE_SETUP: z.object({
    seatCount: z.union([z.literal(2), z.literal(3), z.literal(4)]).optional(),
    targetPlayerId: z.string().uuid().optional(),
    seat: z.number().int().min(0).max(3).nullable().optional(),
    teamId: z.enum(["gold", "green"]).nullable().optional(),
  }).strict(),
  ADD_AI: z.object({ seat: z.number().int().min(0).max(3), difficulty: z.enum(["easy", "medium", "hard"]) }).strict(),
  REMOVE_AI: z.object({ playerId: z.string().uuid() }).strict(),
  REPLACE_WITH_AI: z.object({ playerId: z.string().uuid(), difficulty: z.enum(["easy", "medium", "hard"]) }).strict(),
  START_GAME: z.object({}).strict(),
  CUT_CARD: z.object({}).strict(),
  DISCARD: z.object({ cards: z.array(card).min(1).max(2) }).strict(),
  PLAY_CARD: z.object({ card }).strict(),
  SAY_GO: z.object({}).strict(),
  ACK_COUNT: z.object({ eventId: z.string().uuid() }).strict(),
  NEXT_DEAL: z.object({ eventId: z.string().uuid() }).strict(),
  UPDATE_LEDGER: z.object({
    enabled: z.boolean().optional(),
    baseStakeCents: z.number().int().min(0).max(2000).optional(),
    perHoleCents: z.union([z.literal(5), z.literal(10), z.literal(15), z.literal(20)]).optional(),
  }).strict(),
  REQUEST_REMATCH: z.object({}).strict(),
  REMATCH: z.object({}).strict(),
  WAIT_FOR_PLAYER: z.object({ playerId: z.string().uuid() }).strict(),
  END_GAME: z.object({}).strict(),
  LEAVE_SESSION: z.object({}).strict(),
  LEAVE_ROOM: z.object({}).strict(),
} as const;

export const commandTypes = Object.keys(payloads) as (keyof typeof payloads)[];
export type CommandType = keyof typeof payloads;

const envelope = z.object({
  protocolVersion: z.literal(PROTOCOL_VERSION),
  roomId: z.string().regex(ROOM_CODE),
  playerId: z.string().uuid().nullable(),
  commandId: z.string().uuid(),
  expectedRevision: z.number().int().nonnegative(),
  type: z.enum(commandTypes),
  payload: z.unknown(),
}).strict();

export type Command = {
  [K in CommandType]: z.infer<typeof envelope> & { type: K; payload: z.infer<(typeof payloads)[K]> }
}[CommandType];

export type ErrorCode =
  | "BAD_REQUEST" | "VERSION_MISMATCH" | "ROOM_MISMATCH" | "ROOM_NOT_FOUND"
  | "ROOM_FULL" | "ROOM_STARTED" | "UNAUTHORIZED" | "FORBIDDEN" | "STALE_REVISION"
  | "INVALID_STATE" | "INVALID_ACTION" | "RATE_LIMITED" | "PAYLOAD_TOO_LARGE" | "INTERNAL";

export interface Rejection {
  ok: false;
  commandId: string | null;
  revision: number;
  error: { code: ErrorCode; message: string; retryable: boolean };
}

export interface Acceptance<T = unknown> {
  ok: true;
  commandId: string;
  revision: number;
  event: { type: string; data: T };
}

export type CommandResult<T = unknown> = Acceptance<T> | Rejection;

export function parseCommand(input: unknown): Command {
  const base = envelope.parse(input);
  const type = base.type;
  return { ...base, type, payload: payloads[type].parse(base.payload) } as Command;
}

export function parseCommandText(text: string): Command {
  if (new TextEncoder().encode(text).byteLength > MAX_MESSAGE_BYTES) {
    throw new ProtocolError("PAYLOAD_TOO_LARGE", "Message exceeds 16 KiB.");
  }
  let value: unknown;
  try {
    value = JSON.parse(text) as unknown;
  } catch {
    throw new ProtocolError("BAD_REQUEST", "Message must be valid JSON.");
  }
  try {
    return parseCommand(value);
  } catch (error: unknown) {
    if (error instanceof z.ZodError) {
      const version = typeof value === "object" && value !== null && "protocolVersion" in value
        ? Reflect.get(value, "protocolVersion") : undefined;
      if (version !== PROTOCOL_VERSION) throw new ProtocolError("VERSION_MISMATCH", "Unsupported protocol version.");
      throw new ProtocolError("BAD_REQUEST", "Command schema validation failed.");
    }
    throw error;
  }
}

export class ProtocolError extends Error {
  constructor(
    public readonly code: ErrorCode,
    message: string,
    public readonly retryable = false,
  ) {
    super(message);
    this.name = "ProtocolError";
  }
}

export function reject(error: unknown, revision: number, commandId: string | null = null): Rejection {
  const known = error instanceof ProtocolError ? error : new ProtocolError("INTERNAL", "Unexpected server error.", true);
  return { ok: false, commandId, revision, error: { code: known.code, message: known.message, retryable: known.retryable } };
}
