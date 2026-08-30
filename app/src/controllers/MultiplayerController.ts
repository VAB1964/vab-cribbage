import { createCommand, type CommandEnvelope, type CommandType, type ConnectionState } from "../multiplayer/protocol";

export type MultiplayerSnapshot = { revision: number; roomId: string; [key: string]: unknown };
export type RoomMessage = {
  type?: string;
  revision?: number;
  view?: MultiplayerSnapshot;
  ok?: boolean;
  commandId?: string | null;
  event?: { id?: string; type: string; data: Record<string, unknown> };
  events?: Array<{ id?: string; type: string; data: Record<string, unknown> }>;
  error?: { code: string; message: string; retryable: boolean };
};
type Listener = (state: ConnectionState, snapshot: MultiplayerSnapshot | null, message?: RoomMessage, error?: string) => void;

const record = (value: unknown): value is Record<string, unknown> => Boolean(value) && typeof value === "object" && !Array.isArray(value);

export function parseRoomMessage(value: unknown): RoomMessage | null {
  if (!record(value)) return null;
  const message = value as RoomMessage;
  if (message.type !== undefined && typeof message.type !== "string") return null;
  if (message.revision !== undefined && (!Number.isSafeInteger(message.revision) || message.revision! < 0)) return null;
  if (message.view !== undefined && (!record(message.view) || !Number.isSafeInteger(message.view.revision))) return null;
  if (message.event !== undefined && (!record(message.event) || typeof message.event.type !== "string" || !record(message.event.data))) return null;
  if (message.events !== undefined && (!Array.isArray(message.events) || message.events.some(event => !record(event) || typeof event.type !== "string" || !record(event.data)))) return null;
  if (message.error !== undefined && (!record(message.error) || typeof message.error.message !== "string")) return null;
  return message;
}

export class MultiplayerController {
  private socket: WebSocket | null = null;
  private reconnectAttempt = 0;
  private reconnectTimer: number | null = null;
  private snapshot: MultiplayerSnapshot | null = null;
  private state: ConnectionState = "idle";
  private intentionallyClosed = false;

  constructor(
    private readonly endpoint: string,
    private readonly roomId: string,
    private playerId: string | null,
    private readonly listener: Listener,
  ) {}

  connect() {
    this.intentionallyClosed = false;
    if (this.socket && (this.socket.readyState === WebSocket.OPEN || this.socket.readyState === WebSocket.CONNECTING)) return;
    this.setState(this.reconnectAttempt ? "reconnecting" : "connecting");
    const url = new URL(this.endpoint);
    url.searchParams.set("room", this.roomId);
    this.socket = new WebSocket(url);
    this.socket.addEventListener("open", () => {
      this.reconnectAttempt = 0;
      this.setState("connected");
    });
    this.socket.addEventListener("message", event => {
      let decoded: unknown;
      try {
        decoded = JSON.parse(String(event.data));
      } catch {
        this.listener(this.state, this.snapshot, undefined, "The room sent an unreadable update.");
        return;
      }
      const message = parseRoomMessage(decoded);
      if (!message) {
        this.listener(this.state, this.snapshot, undefined, "The room sent an invalid update.");
        return;
      }
      if (message.type === "CONNECTED" && typeof message.revision === "number" && !this.snapshot) {
        this.snapshot = { roomId: this.roomId, revision: message.revision };
      }
      if (message.view && (!this.snapshot || message.view.revision >= this.snapshot.revision)) this.snapshot = message.view;
      this.listener(this.state, this.snapshot, message);
    });
    this.socket.addEventListener("close", () => {
      this.socket = null;
      if (!this.intentionallyClosed) this.scheduleReconnect();
    });
    this.socket.addEventListener("error", () => this.listener(this.state, this.snapshot, undefined, "Unable to reach the room service."));
  }

  setPlayerId(playerId: string) {
    this.playerId = playerId;
  }

  send<T>(type: CommandType, payload: T): CommandEnvelope<T> {
    const command = createCommand(type, payload, {
      roomId: this.roomId,
      playerId: this.playerId,
      expectedRevision: this.snapshot?.revision ?? 0,
    });
    if (this.socket?.readyState !== WebSocket.OPEN) throw new Error("The room is reconnecting. Please wait.");
    this.socket.send(JSON.stringify(command));
    return command;
  }

  disconnect() {
    this.intentionallyClosed = true;
    if (this.reconnectTimer !== null) window.clearTimeout(this.reconnectTimer);
    this.reconnectTimer = null;
    this.socket?.close();
    this.socket = null;
    this.setState("offline");
  }

  private scheduleReconnect() {
    if (this.state === "offline" || this.intentionallyClosed || this.reconnectTimer !== null) return;
    this.setState("reconnecting");
    const delay = Math.min(30_000, 750 * 2 ** this.reconnectAttempt++);
    this.reconnectTimer = window.setTimeout(() => {
      this.reconnectTimer = null;
      this.connect();
    }, delay);
  }

  private setState(state: ConnectionState) {
    this.state = state;
    this.listener(state, this.snapshot);
  }
}
