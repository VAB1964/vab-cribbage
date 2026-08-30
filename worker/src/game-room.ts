import { DurableObject } from "cloudflare:workers";
import { type Command, type CommandResult, ProtocolError, parseCommandText, reject } from "./protocol";
import { initialGame, playerView, type Player, type RoomState } from "./model";

interface SocketAttachment {
  playerId: string | null;
  connectedAt: number;
}

type StoredSnapshot = Record<string, SqlStorageValue> & { state_json: string };
type StoredResult = Record<string, SqlStorageValue> & { result_json: string };

const HOST_GRACE_MS = 30_000;
const COMMAND_CACHE_LIMIT = 256;
const SOCKET_RATE_WINDOW_MS = 10_000;
const SOCKET_RATE_LIMIT = 40;
const ACTIVE_EXPIRY_MS = 24 * 60 * 60 * 1000;
const COMPLETE_EXPIRY_MS = 60 * 60 * 1000;

export class GameRoom extends DurableObject<Env> {
  private state: RoomState | null = null;
  private readonly socketRates = new WeakMap<WebSocket, { startedAt: number; count: number }>();

  constructor(ctx: DurableObjectState, env: Env) {
    super(ctx, env);
    ctx.blockConcurrencyWhile(async () => {
      this.ctx.storage.sql.exec(`
        CREATE TABLE IF NOT EXISTS room_snapshot (
          singleton INTEGER PRIMARY KEY CHECK(singleton = 1),
          state_json TEXT NOT NULL
        );
        CREATE TABLE IF NOT EXISTS command_results (
          command_id TEXT PRIMARY KEY,
          result_json TEXT NOT NULL,
          created_at INTEGER NOT NULL
        );
      `);
      this.state = this.restore();
    });
  }

  async initialize(roomId: string): Promise<boolean> {
    if (this.state !== null) return false;
    const now = Date.now();
    this.state = {
      roomId, revision: 0, status: "lobby", createdAt: now, hostPlayerId: "",
      seatCount: 2, settingsVersion: 0, players: [], game: initialGame(),
      ledger: { enabled: true, baseStakeCents: 100, perHoleCents: 5, entries: [] },
      rematchRequests: [], dialogue: [], lastActivityAt: now, expiresAt: now + ACTIVE_EXPIRY_MS,
    };
    this.persist(this.state);
    await this.ctx.storage.setAlarm(this.state.expiresAt);
    return true;
  }

  async exists(): Promise<boolean> {
    return this.state !== null;
  }

  override async fetch(request: Request): Promise<Response> {
    return this.upgradeWebSocket(request);
  }

  async upgradeWebSocket(request: Request): Promise<Response> {
    if (request.headers.get("Upgrade")?.toLowerCase() !== "websocket") {
      return Response.json({ error: "WebSocket upgrade required." }, { status: 426 });
    }
    if (this.state === null) return Response.json({ error: "Room not found." }, { status: 404 });
    const pair = new WebSocketPair();
    const client = pair[0];
    const server = pair[1];
    this.ctx.acceptWebSocket(server);
    server.serializeAttachment({ playerId: null, connectedAt: Date.now() } satisfies SocketAttachment);
    server.send(JSON.stringify({ type: "CONNECTED", protocolVersion: 1, revision: this.state.revision }));
    return new Response(null, { status: 101, webSocket: client });
  }

  async executeForTest(command: Command): Promise<CommandResult> {
    return this.execute(command, null);
  }

  async viewForTest(playerId: string | null): Promise<ReturnType<typeof playerView> | null> {
    return this.state === null ? null : playerView(this.state, playerId);
  }

  async disconnectForTest(playerId: string): Promise<void> {
    if (!this.state) return;
    const player = this.state.players.find((candidate) => candidate.id === playerId);
    if (!player) return;
    player.connected = false;
    if (this.state.status === "playing" && !player.isAI) {
      this.state.game.pausedForPlayerId = player.id;
      dialogue(this.state, "PLAYER_DISCONNECTED", player.id);
    }
    this.state.revision += 1;
    this.persist(this.state);
    if (player.id === this.state.hostPlayerId) await this.ctx.storage.setAlarm(Date.now() + HOST_GRACE_MS);
  }

  override async webSocketMessage(socket: WebSocket, message: string | ArrayBuffer): Promise<void> {
    if (typeof message !== "string") {
      socket.send(JSON.stringify(reject(new ProtocolError("BAD_REQUEST", "Binary messages are not supported."), this.state?.revision ?? 0)));
      return;
    }
    if (!this.consumeRate(socket)) {
      socket.send(JSON.stringify(reject(new ProtocolError("RATE_LIMITED", "Too many commands.", true), this.state?.revision ?? 0)));
      return;
    }
    let command: Command;
    try {
      command = parseCommandText(message);
    } catch (error: unknown) {
      socket.send(JSON.stringify(reject(error, this.state?.revision ?? 0)));
      return;
    }
    const result = await this.execute(command, socket);
    socket.send(JSON.stringify(result));
  }

  override async webSocketClose(socket: WebSocket, code: number, _reason: string, wasClean: boolean): Promise<void> {
    const attachment = socket.deserializeAttachment() as SocketAttachment | null;
    if (attachment?.playerId && this.state) {
      const player = this.state.players.find((candidate) => candidate.id === attachment.playerId);
      if (player && player.connected) {
        player.connected = false;
        if (this.state.status === "playing" && !player.isAI) {
          this.state.game.pausedForPlayerId = player.id;
          dialogue(this.state, "PLAYER_DISCONNECTED", player.id);
        }
        this.state.revision += 1;
        this.persist(this.state);
        this.broadcastViews();
        if (player.id === this.state.hostPlayerId) await this.ctx.storage.setAlarm(Date.now() + HOST_GRACE_MS);
      }
    }
    if (!wasClean) this.safeLog("socket_closed", { code });
  }

  override async webSocketError(socket: WebSocket): Promise<void> {
    const attachment = socket.deserializeAttachment() as SocketAttachment | null;
    this.safeLog("socket_error", { playerId: attachment?.playerId ?? null });
  }

  override async alarm(): Promise<void> {
    if (!this.state) return;
    if (Date.now() >= this.state.expiresAt) {
      for (const socket of this.ctx.getWebSockets()) socket.close(1001, "Room expired");
      this.ctx.storage.sql.exec("DELETE FROM command_results; DELETE FROM room_snapshot;");
      this.state = null;
      return;
    }
    const host = this.state.players.find((player) => player.id === this.state?.hostPlayerId);
    if (!host?.connected) {
      const successor = this.state.players
        .filter((player) => !player.isAI && player.connected && !player.replacedPermanently)
        .sort((a, b) => a.joinedAt - b.joinedAt)[0];
      if (successor && successor.id !== this.state.hostPlayerId) {
        this.state.hostPlayerId = successor.id;
        this.state.revision += 1;
        dialogue(this.state, "HOST_MIGRATED", successor.id);
        this.persist(this.state);
        this.broadcastViews();
      }
    }
    await this.ctx.storage.setAlarm(this.state.expiresAt);
  }

  private restore(): RoomState | null {
    const row = this.ctx.storage.sql.exec<StoredSnapshot>(
      "SELECT state_json FROM room_snapshot WHERE singleton = 1",
    ).toArray()[0];
    if (!row) return null;
    const state = JSON.parse(row.state_json) as RoomState;
    state.ledger ??= { enabled: true, baseStakeCents: 100, perHoleCents: 5, entries: [] };
    state.ledger.perHoleCents ??= 5;
    state.rematchRequests ??= []; state.dialogue ??= []; state.lastActivityAt ??= Date.now();
    state.expiresAt ??= state.lastActivityAt + ACTIVE_EXPIRY_MS;
    state.game = { ...initialGame(), ...state.game };
    return state;
  }

  private persist(state: RoomState): void {
    this.ctx.storage.sql.exec(
      "INSERT INTO room_snapshot(singleton, state_json) VALUES(1, ?) ON CONFLICT(singleton) DO UPDATE SET state_json = excluded.state_json",
      JSON.stringify(state),
    );
  }

  private async execute(command: Command, socket: WebSocket | null): Promise<CommandResult> {
    if (!this.state) return reject(new ProtocolError("ROOM_NOT_FOUND", "Room does not exist."), 0, command.commandId);
    const cached = this.ctx.storage.sql.exec<StoredResult>(
      "SELECT result_json FROM command_results WHERE command_id = ?", command.commandId,
    ).toArray()[0];
    if (cached) return JSON.parse(cached.result_json) as CommandResult;

    let result: CommandResult;
    const stateBeforeCommand = structuredClone(this.state);
    try {
      if (command.roomId !== this.state.roomId) throw new ProtocolError("ROOM_MISMATCH", "Command targets another room.");
      const secureReconnect = command.type === "JOIN_ROOM" && Boolean(command.payload.reconnectToken);
      if (command.expectedRevision !== this.state.revision && !secureReconnect) {
        throw new ProtocolError("STALE_REVISION", "Refresh room state before retrying.");
      }
      const data = await this.apply(command, socket);
      this.state.lastActivityAt = Date.now();
      this.state.expiresAt = this.state.lastActivityAt + (this.state.status === "complete" ? COMPLETE_EXPIRY_MS : ACTIVE_EXPIRY_MS);
      this.state.revision += 1;
      result = { ok: true, commandId: command.commandId, revision: this.state.revision, event: { type: `${command.type}_ACCEPTED`, data } };
      this.ctx.storage.transactionSync(() => {
        this.persist(this.state as RoomState);
        this.ctx.storage.sql.exec(
          "INSERT INTO command_results(command_id, result_json, created_at) VALUES(?, ?, ?)",
          command.commandId, JSON.stringify(result), Date.now(),
        );
        this.ctx.storage.sql.exec(`
          DELETE FROM command_results WHERE command_id IN (
            SELECT command_id FROM command_results ORDER BY created_at DESC LIMIT -1 OFFSET ?
          )
        `, COMMAND_CACHE_LIMIT);
      });
    } catch (error: unknown) {
      this.state = stateBeforeCommand;
      result = reject(error, this.state.revision, command.commandId);
      this.ctx.storage.sql.exec(
        "INSERT INTO command_results(command_id, result_json, created_at) VALUES(?, ?, ?)",
        command.commandId, JSON.stringify(result), Date.now(),
      );
      return result;
    }
    await this.ctx.storage.setAlarm(this.state.expiresAt);
    this.broadcastViews();
    return result;
  }

  private async apply(command: Command, socket: WebSocket | null): Promise<Record<string, unknown>> {
    const state = this.state as RoomState;
    if (command.type === "CREATE_ROOM") {
      if (state.players.length > 0) throw new ProtocolError("INVALID_STATE", "Room is already created.");
      const token = secureToken();
      const player = await humanPlayer(command.payload.name, command.payload.avatarId, 0, token);
      state.players.push(player);
      state.hostPlayerId = player.id;
      state.seatCount = command.payload.seatCount;
      this.attach(socket, player.id);
      return { playerId: player.id, reconnectToken: token };
    }
    if (command.type === "JOIN_ROOM") {
      if (command.payload.reconnectToken) {
        const hash = await hashToken(command.payload.reconnectToken);
        const returning = state.players.find((player) => player.id === command.playerId && player.reconnectTokenHash === hash);
        if (!returning || returning.replacedPermanently) throw new ProtocolError("UNAUTHORIZED", "Reconnect token is invalid.");
        returning.connected = true;
        if (state.game.pausedForPlayerId === returning.id) state.game.pausedForPlayerId = null;
        returning.name = command.payload.name;
        returning.avatarId = command.payload.avatarId;
        this.attach(socket, returning.id);
        return { playerId: returning.id, reconnected: true };
      }
      if (state.status !== "lobby") throw new ProtocolError("ROOM_STARTED", "Game already started.");
      const occupied = new Set(state.players.filter((player) => player.seat !== null).map((player) => player.seat));
      const seat = Array.from({ length: state.seatCount }, (_, index) => index).find((index) => !occupied.has(index));
      if (seat === undefined) throw new ProtocolError("ROOM_FULL", "Room is full.");
      const token = secureToken();
      const player = await humanPlayer(command.payload.name, command.payload.avatarId, seat, token);
      state.players.push(player);
      this.attach(socket, player.id);
      return { playerId: player.id, reconnectToken: token };
    }

    const actor = this.actor(command.playerId);
    switch (command.type) {
      case "UPDATE_IDENTITY":
        actor.name = command.payload.name; actor.avatarId = command.payload.avatarId;
        return {};
      case "SET_READY":
        this.requireLobby();
        actor.ready = command.payload.ready;
        return { ready: actor.ready };
      case "ASSIGN_SEAT": {
        this.requireHost(actor); this.requireLobby();
        const target = this.actor(command.payload.targetPlayerId);
        if (command.payload.seat !== null && (command.payload.seat >= state.seatCount ||
          state.players.some((player) => player.id !== target.id && player.seat === command.payload.seat))) {
          throw new ProtocolError("INVALID_ACTION", "Seat is unavailable.");
        }
        target.seat = command.payload.seat; state.settingsVersion += 1;
        return { settingsVersion: state.settingsVersion };
      }
      case "ASSIGN_TEAM": {
        this.requireHost(actor); this.requireLobby();
        this.actor(command.payload.targetPlayerId).teamId = command.payload.teamId;
        state.settingsVersion += 1; return { settingsVersion: state.settingsVersion };
      }
      case "UPDATE_SETUP": {
        this.requireHost(actor);
        this.requireLobby();
        if (command.payload.seatCount !== undefined) {
          if (state.players.some((player) => player.seat !== null && player.seat >= command.payload.seatCount!)) {
            throw new ProtocolError("INVALID_ACTION", "Move players out of removed seats first.");
          }
          state.seatCount = command.payload.seatCount;
          for (const player of state.players) {
            player.teamId = state.seatCount === 4 && player.seat !== null
              ? (player.seat % 2 === 0 ? "gold" : "green")
              : null;
          }
        }
        const target = command.payload.targetPlayerId ? this.actor(command.payload.targetPlayerId) : null;
        if (target && command.payload.seat !== undefined) target.seat = command.payload.seat;
        if (target && command.payload.teamId !== undefined) target.teamId = command.payload.teamId;
        state.settingsVersion += 1;
        return { settingsVersion: state.settingsVersion };
      }
      case "ADD_AI": {
        this.requireHost(actor); this.requireLobby();
        if (command.payload.seat >= state.seatCount || state.players.some((player) => player.seat === command.payload.seat)) {
          throw new ProtocolError("INVALID_ACTION", "Seat is unavailable.");
        }
        state.players.push(aiPlayer(command.payload.seat, command.payload.difficulty));
        return {};
      }
      case "REMOVE_AI": {
        this.requireHost(actor); this.requireLobby();
        const index = state.players.findIndex((player) => player.id === command.payload.playerId && player.isAI);
        if (index < 0) throw new ProtocolError("INVALID_ACTION", "AI player not found.");
        state.players.splice(index, 1);
        return {};
      }
      case "REPLACE_WITH_AI": {
        this.requireHost(actor);
        const target = this.actor(command.payload.playerId);
        if (target.connected || target.isAI) throw new ProtocolError("INVALID_ACTION", "Only a disconnected human can be replaced.");
        target.isAI = true; target.aiDifficulty = command.payload.difficulty; target.reconnectTokenHash = null;
        target.replacedPermanently = true; target.ready = true;
        if (state.game.pausedForPlayerId === target.id) state.game.pausedForPlayerId = null;
        runAi(state);
        return {};
      }
      case "START_GAME":
        this.requireHost(actor); this.requireLobby(); this.validateStart();
        state.status = "playing"; state.game = initialGame(); state.game.phase = "cut";
        state.game.teamScores = Object.fromEntries(teamIds(state).map((id) => [id, 0]));
        makeCutDeck(state);
        runAi(state);
        return { phase: state.game.phase };
      case "CUT_CARD": {
        const cutEligible = state.game.acknowledgements.length === 0 || state.game.acknowledgements.includes(actor.id);
        if (state.game.phase !== "cut" || actor.seat === null || state.game.cutCards[actor.id] || !cutEligible) {
          throw new ProtocolError("INVALID_ACTION", "Cannot cut now.");
        }
        const cut = state.game.deck.pop();
        if (!cut) throw new ProtocolError("INTERNAL", "Cut deck exhausted.");
        state.game.cutCards[actor.id] = cut;
        resolveCut(state); runAi(state);
        return { card: cut };
      }
      case "DISCARD": {
        if (state.game.phase !== "discard") throw new ProtocolError("INVALID_STATE", "Not discarding now.");
        const hand = state.game.hands[actor.id] ?? [];
        const required = state.seatCount === 2 ? 2 : 1;
        if (hand.length !== (state.seatCount === 2 ? 6 : 5)) throw new ProtocolError("INVALID_ACTION", "Player already discarded.");
        if (command.payload.cards.length !== required || new Set(command.payload.cards).size !== required) {
          throw new ProtocolError("INVALID_ACTION", `Discard exactly ${required} distinct card${required === 1 ? "" : "s"}.`);
        }
        if (!command.payload.cards.every((card) => hand.includes(card))) throw new ProtocolError("INVALID_ACTION", "Card is not in hand.");
        state.game.hands[actor.id] = hand.filter((card) => !command.payload.cards.includes(card));
        state.game.crib.push(...command.payload.cards);
        const allDiscarded = state.players
          .filter((player) => player.seat !== null && (player.seat as number) < state.seatCount)
          .every((player) => state.game.hands[player.id]?.length === 4);
        if (allDiscarded) {
          if (state.seatCount === 3) {
            const kitty = state.game.deck.pop();
            if (!kitty) throw new ProtocolError("INTERNAL", "Deck exhausted while adding the crib card.");
            state.game.crib.push(kitty);
          }
          const starter = state.game.deck.pop();
          if (!starter || state.game.crib.length !== 4) throw new ProtocolError("INTERNAL", "Deal did not produce a valid crib.");
          state.game.starterCard = starter;
          state.game.countHands = structuredClone(state.game.hands);
          state.game.phase = "pegging";
          state.game.turnSeat = nextOccupiedSeat(state, state.game.dealerSeat as number);
          if (rankOf(starter) === "J") {
            const dealerSeat = state.game.dealerSeat as number;
            const dealer = seated(state).find((player) => player.seat === dealerSeat);
            const dealerTeam = teamForSeat(state, dealerSeat);
            award(state, dealerTeam, 2);
            const score = state.game.teamScores[dealerTeam] ?? 0;
            dialogue(state, "STARTER_JACK", dealer?.id, undefined, {
              points: 2,
              score,
              message: `${dealer?.name ?? "Dealer"} scores 2 for his heels (starter jack); score ${score}.`,
            });
          }
        }
        runAi(state);
        return {};
      }
      case "PLAY_CARD": {
        requireUnpaused(state);
        if (state.game.phase !== "pegging" || actor.seat !== state.game.turnSeat) throw new ProtocolError("INVALID_ACTION", "Not this player's turn.");
        const value = cardValue(command.payload.card);
        const hand = state.game.hands[actor.id] ?? [];
        if (!hand.includes(command.payload.card) || state.game.runningCount + value > 31) throw new ProtocolError("INVALID_ACTION", "Card cannot be played.");
        state.game.hands[actor.id] = hand.filter((card) => card !== command.payload.card);
        state.game.playedCards.push({ playerId: actor.id, card: command.payload.card });
        state.game.sequenceCards.push({ playerId: actor.id, card: command.payload.card });
        state.game.runningCount += value; state.game.lastPegger = actor.id;
        const points = peggingPoints(state.game.sequenceCards.map((play) => play.card), state.game.runningCount);
        const reason = peggingReason(state.game.sequenceCards.map((play) => play.card), state.game.runningCount);
        const playedCount = state.game.runningCount;
        const actorTeam = teamForPlayer(state, actor);
        if (award(state, actorTeam, points)) {
          const score = state.game.teamScores[actorTeam] ?? 0;
          dialogue(state, "PEG_PLAY", actor.id, undefined, { card: command.payload.card, reason, runningCount: playedCount, points, score,
            message: `${actor.name} played ${command.payload.card}, ${reason}; count ${playedCount}; score ${score}; game complete.` });
          return { runningCount: state.game.runningCount, points };
        }
        if (state.game.runningCount === 31) resetPeggingSequence(state, actor.seat as number);
        else advancePegging(state, actor.seat as number);
        const next = seated(state).find((player) => player.seat === state.game.turnSeat);
        const score = state.game.teamScores[actorTeam] ?? 0;
        dialogue(state, "PEG_PLAY", actor.id, undefined, { card: command.payload.card, reason, runningCount: playedCount, points, score, ...(next ? { nextPlayerId: next.id } : {}),
          message: `${actor.name} played ${command.payload.card}, ${reason}; count ${playedCount}; ${points} point${points === 1 ? "" : "s"}; score ${score}.${next ? ` ${next.name}'s turn.` : ""}` });
        runAi(state);
        return { runningCount: state.game.runningCount, points };
      }
      case "SAY_GO":
        requireUnpaused(state);
        if (state.game.phase !== "pegging" || actor.seat !== state.game.turnSeat) throw new ProtocolError("INVALID_ACTION", "Cannot say Go now.");
        if ((state.game.hands[actor.id] ?? []).some((card) => state.game.runningCount + cardValue(card) <= 31)) {
          throw new ProtocolError("INVALID_ACTION", "A legal card is available.");
        }
        if (!state.game.goPlayers.includes(actor.id)) state.game.goPlayers.push(actor.id);
        advancePegging(state, actor.seat as number);
        const next = seated(state).find((player) => player.seat === state.game.turnSeat);
        dialogue(state, "PEG_GO", actor.id, undefined, { runningCount: state.game.runningCount, ...(next ? { nextPlayerId: next.id } : {}),
          message: `${actor.name} said Go at ${state.game.runningCount}.${next ? ` ${next.name}'s turn.` : ""}` });
        runAi(state);
        return {};
      case "ACK_COUNT": {
        if (state.game.phase !== "counting" || command.payload.eventId !== state.game.pendingEventId) {
          throw new ProtocolError("INVALID_ACTION", "Count event is not current.");
        }
        if (!state.game.acknowledgements.includes(actor.id)) state.game.acknowledgements.push(actor.id);
        const humans = seated(state).filter((player) => !player.isAI && !player.replacedPermanently);
        if (humans.every((player) => state.game.acknowledgements.includes(player.id))) advanceCount(state);
        runAi(state);
        return { eventId: command.payload.eventId };
      }
      case "NEXT_DEAL":
        this.requireHost(actor);
        if (state.game.phase !== "dealComplete" || command.payload.eventId !== state.game.pendingEventId) {
          throw new ProtocolError("INVALID_ACTION", "Deal is not ready to advance.");
        }
        startDeal(state, ((state.game.dealerSeat as number) + 1) % state.seatCount);
        runAi(state);
        return { eventId: command.payload.eventId };
      case "UPDATE_LEDGER":
        this.requireHost(actor); this.requireLobby();
        if (state.ledger.entries.length > 0) throw new ProtocolError("INVALID_STATE", "Ledger settings are locked after the first result.");
        Object.assign(state.ledger, command.payload); state.settingsVersion += 1;
        return { settingsVersion: state.settingsVersion };
      case "REQUEST_REMATCH":
        if (state.status !== "complete") throw new ProtocolError("INVALID_STATE", "Game is not complete.");
        if (!state.rematchRequests.includes(actor.id)) state.rematchRequests.push(actor.id);
        if (seated(state).filter((p) => !p.isAI).every((p) => state.rematchRequests.includes(p.id))) resetForRematch(state);
        return {};
      case "REMATCH":
        this.requireHost(actor);
        if (state.status !== "complete") throw new ProtocolError("INVALID_STATE", "Game is not complete.");
        resetForRematch(state);
        return {};
      case "WAIT_FOR_PLAYER":
        this.requireHost(actor);
        if (state.game.pausedForPlayerId !== command.payload.playerId) throw new ProtocolError("INVALID_ACTION", "Player is not blocking play.");
        return {};
      case "END_GAME":
        this.requireHost(actor);
        state.status = "complete"; state.game.phase = "complete";
        state.game.pendingEventId = dialogue(state, "GAME_ENDED", actor.id);
        return {};
      case "LEAVE_SESSION":
      case "LEAVE_ROOM":
        actor.connected = false; actor.ready = false;
        if (state.status === "lobby") state.players = state.players.filter((player) => player.id !== actor.id);
        if (actor.id === state.hostPlayerId) await this.ctx.storage.setAlarm(Date.now() + HOST_GRACE_MS);
        this.attach(socket, null);
        return {};
      default:
        return command satisfies never;
    }
  }

  private actor(playerId: string | null): Player {
    const player = this.state?.players.find((candidate) => candidate.id === playerId);
    if (!player || player.replacedPermanently) throw new ProtocolError("UNAUTHORIZED", "Player identity is invalid.");
    return player;
  }

  private requireHost(player: Player): void {
    if (player.id !== this.state?.hostPlayerId) throw new ProtocolError("FORBIDDEN", "Host permission required.");
  }

  private requireLobby(): void {
    if (this.state?.status !== "lobby") throw new ProtocolError("INVALID_STATE", "Command is only allowed in the lobby.");
  }

  private validateStart(): void {
    const state = this.state as RoomState;
    const seated = state.players.filter((player) => player.seat !== null && (player.seat as number) < state.seatCount);
    if (seated.length !== state.seatCount) throw new ProtocolError("INVALID_STATE", "All seats must be occupied.");
    if (seated.some((player) => !player.isAI && (!player.ready || !player.connected))) {
      throw new ProtocolError("INVALID_STATE", "All human players must be connected and ready.");
    }
    if (state.seatCount === 4) {
      for (const player of seated) player.teamId = (player.seat as number) % 2 === 0 ? "gold" : "green";
    }
  }

  private attach(socket: WebSocket | null, playerId: string | null): void {
    if (!socket) return;
    socket.serializeAttachment({ playerId, connectedAt: Date.now() } satisfies SocketAttachment);
  }

  private broadcastViews(): void {
    if (!this.state) return;
    for (const socket of this.ctx.getWebSockets()) {
      const attachment = socket.deserializeAttachment() as SocketAttachment | null;
      try { socket.send(JSON.stringify({ type: "STATE", view: playerView(this.state, attachment?.playerId ?? null) })); }
      catch { /* A later close/error callback reconciles connection state. */ }
    }
  }

  private consumeRate(socket: WebSocket): boolean {
    const now = Date.now();
    const current = this.socketRates.get(socket);
    if (!current || now - current.startedAt >= SOCKET_RATE_WINDOW_MS) {
      this.socketRates.set(socket, { startedAt: now, count: 1 });
      return true;
    }
    current.count += 1;
    return current.count <= SOCKET_RATE_LIMIT;
  }

  private safeLog(event: string, fields: Record<string, string | number | null>): void {
    console.log(JSON.stringify({ event, ...fields }));
  }
}

async function humanPlayer(name: string, avatarId: string, seat: number, token: string): Promise<Player> {
  return {
    id: crypto.randomUUID(), name, avatarId, seat, teamId: null, connected: true,
    ready: false, isAI: false, aiDifficulty: null, reconnectTokenHash: await hashToken(token),
    replacedPermanently: false, joinedAt: Date.now(),
  };
}

function aiPlayer(seat: number, difficulty: "easy" | "medium" | "hard"): Player {
  return {
    id: crypto.randomUUID(), name: `AI ${seat + 1}`, avatarId: "g-4", seat,
    teamId: seat % 2 === 0 ? "gold" : "green", connected: true, ready: true,
    isAI: true, aiDifficulty: difficulty, reconnectTokenHash: null,
    replacedPermanently: true, joinedAt: Date.now(),
  };
}

function secureToken(): string {
  const bytes = crypto.getRandomValues(new Uint8Array(32));
  return Array.from(bytes, (byte) => byte.toString(16).padStart(2, "0")).join("");
}

async function hashToken(token: string): Promise<string> {
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(token));
  return Array.from(new Uint8Array(digest), (byte) => byte.toString(16).padStart(2, "0")).join("");
}

function dealFoundation(state: RoomState): void {
  const deck = ["A", "2", "3", "4", "5", "6", "7", "8", "9", "10", "J", "Q", "K"]
    .flatMap((rank) => ["C", "D", "H", "S"].map((suit) => `${rank}${suit}`));
  for (let index = deck.length - 1; index > 0; index -= 1) {
    const swap = cryptoInt(index + 1);
    [deck[index], deck[swap]] = [deck[swap]!, deck[index]!];
  }
  const handSize = state.seatCount === 2 ? 6 : 5;
  for (const player of state.players.filter((candidate) => candidate.seat !== null)) {
    state.game.hands[player.id] = deck.splice(0, handSize);
  }
  state.game.deck = deck;
  state.game.starterCard = null;
}

function cryptoInt(upperExclusive: number): number {
  if (!Number.isSafeInteger(upperExclusive) || upperExclusive < 1 || upperExclusive > 0x1_0000_0000) {
    throw new RangeError("Invalid cryptographic random range");
  }
  const range = 0x1_0000_0000;
  const limit = range - (range % upperExclusive);
  const sample = new Uint32Array(1);
  do crypto.getRandomValues(sample); while (sample[0]! >= limit);
  return sample[0]! % upperExclusive;
}

function cardValue(card: string): number {
  const rank = card.slice(0, -1);
  return rank === "A" ? 1 : ["J", "Q", "K"].includes(rank) ? 10 : Number(rank);
}

function nextOccupiedSeat(state: RoomState, seat: number): number {
  const occupied = new Set(state.players.filter((player) => player.seat !== null).map((player) => player.seat));
  for (let offset = 1; offset <= state.seatCount; offset += 1) {
    const candidate = (seat + offset) % state.seatCount;
    if (occupied.has(candidate)) return candidate;
  }
  return seat;
}

function seated(state: RoomState): Player[] {
  return state.players.filter((player) => player.seat !== null && player.seat < state.seatCount)
    .sort((a, b) => (a.seat as number) - (b.seat as number));
}

function teamForSeat(state: RoomState, seat: number): string {
  if (state.seatCount === 4) return seat % 2 === 0 ? "gold" : "green";
  return seated(state).find((player) => player.seat === seat)!.id;
}

function teamForPlayer(state: RoomState, player: Player): string {
  return teamForSeat(state, player.seat as number);
}

function teamIds(state: RoomState): string[] {
  return state.seatCount === 4 ? ["gold", "green"] : seated(state).map((player) => teamForPlayer(state, player));
}

function rankOf(card: string): string { return card.slice(0, -1); }
export function cutRank(card: string): number {
  const rank = rankOf(card);
  return rank === "A" ? 1 : rank === "J" ? 11 : rank === "Q" ? 12 : rank === "K" ? 13 : Number(rank);
}
const rankNumber = cutRank;

function makeDeck(): string[] {
  return ["A", "2", "3", "4", "5", "6", "7", "8", "9", "10", "J", "Q", "K"]
    .flatMap((rank) => ["C", "D", "H", "S"].map((suit) => `${rank}${suit}`));
}

function shuffle(cards: string[]): void {
  for (let index = cards.length - 1; index > 0; index -= 1) {
    const swap = cryptoInt(index + 1);
    [cards[index], cards[swap]] = [cards[swap]!, cards[index]!];
  }
}

function makeCutDeck(state: RoomState): void {
  state.game.deck = makeDeck(); shuffle(state.game.deck);
  state.game.cutCards = {}; state.game.acknowledgements = [];
}

function resolveCut(state: RoomState): void {
  const eligible = state.game.acknowledgements.length
    ? seated(state).filter((player) => state.game.acknowledgements.includes(player.id)) : seated(state);
  if (!eligible.every((player) => state.game.cutCards[player.id])) return;
  const low = Math.min(...eligible.map((player) => cutRank(state.game.cutCards[player.id]!)));
  const tied = eligible.filter((player) => cutRank(state.game.cutCards[player.id]!) === low);
  if (tied.length > 1) {
    state.game.cutCards = {}; state.game.acknowledgements = tied.map((player) => player.id);
    dialogue(state, "CUT_TIE");
    return;
  }
  startDeal(state, tied[0]!.seat as number);
}

function startDeal(state: RoomState, dealerSeat: number): void {
  const scores = state.game.teamScores;
  const cutCards = state.game.cutCards;
  const dealNumber = state.game.dealNumber + 1;
  state.game = initialGame(); state.game.teamScores = scores; state.game.dealNumber = dealNumber;
  state.game.cutCards = cutCards;
  state.game.phase = "discard"; state.game.dealerSeat = dealerSeat;
  state.game.turnSeat = (dealerSeat + 1) % state.seatCount;
  dealFoundation(state);
}

export function peggingPoints(cards: string[], count: number): number {
  let points = count === 15 || count === 31 ? 2 : 0;
  const lastRank = cards.length ? rankOf(cards[cards.length - 1]!) : "";
  let same = 0;
  for (let index = cards.length - 1; index >= 0 && rankOf(cards[index]!) === lastRank; index -= 1) same += 1;
  if (same === 2) points += 2;
  else if (same === 3) points += 6;
  else if (same >= 4) points += 12;
  for (let size = Math.min(cards.length, 7); size >= 3; size -= 1) {
    const ranks = cards.slice(-size).map(rankNumber);
    const unique = new Set(ranks);
    if (unique.size === size && Math.max(...ranks) - Math.min(...ranks) === size - 1) {
      points += size; break;
    }
  }
  return points;
}

function peggingReason(cards: string[], count: number): string {
  const reasons: string[] = [];
  if (count === 15) reasons.push("makes 15");
  if (count === 31) reasons.push("makes 31");
  const lastRank = cards.length ? rankOf(cards[cards.length - 1]!) : "";
  let same = 0;
  for (let index = cards.length - 1; index >= 0 && rankOf(cards[index]!) === lastRank; index -= 1) same += 1;
  if (same === 2) reasons.push(`pairs ${cards[cards.length - 2]}`);
  else if (same === 3) reasons.push("three of a kind");
  else if (same >= 4) reasons.push("four of a kind");
  for (let size = Math.min(cards.length, 7); size >= 3; size -= 1) {
    const ranks = cards.slice(-size).map(rankNumber);
    if (new Set(ranks).size === size && Math.max(...ranks) - Math.min(...ranks) === size - 1) {
      reasons.push(`run of ${size}`);
      break;
    }
  }
  return reasons.length ? reasons.join(", ") : "no points";
}

function award(state: RoomState, teamId: string, points: number): boolean {
  if (points <= 0 || state.game.phase === "complete") return false;
  state.game.teamScores[teamId] = Math.min(121, (state.game.teamScores[teamId] ?? 0) + points);
  if (state.game.teamScores[teamId]! < 121) return false;
  const losing = Math.max(...Object.entries(state.game.teamScores).filter(([id]) => id !== teamId).map(([, score]) => score), 0);
  const result = losing <= 60 ? "double-skunk" : losing <= 90 ? "skunk" : "normal";
  state.game.winnerTeamId = teamId; state.game.result = result; state.game.phase = "complete"; state.status = "complete";
  state.game.pendingEventId = dialogue(state, "GAME_WON");
  if (state.ledger.enabled) {
    const multiplier = result === "double-skunk" ? 4 : result === "skunk" ? 2 : 1;
    const players = seated(state);
    const winners = players.filter((player) => teamForPlayer(state, player) === teamId);
    const losers = players.filter((player) => teamForPlayer(state, player) !== teamId);
    const holesBehind = Object.fromEntries(Object.entries(state.game.teamScores)
      .filter(([id]) => id !== teamId).map(([id, score]) => [id, Math.max(0, 121 - score)]));
    const perPlayerCents: Record<string, number> = {};
    let totalOwed = 0;
    for (const player of losers) {
      const amount = (state.ledger.baseStakeCents + (holesBehind[teamForPlayer(state, player)] ?? 0) * state.ledger.perHoleCents) * multiplier;
      perPlayerCents[player.id] = -amount;
      totalOwed += amount;
    }
    if (totalOwed % winners.length !== 0) throw new Error("Ledger winner shares are not divisible in integer cents");
    for (const player of winners) perPlayerCents[player.id] = totalOwed / winners.length;
    state.ledger.entries.push({
      id: crypto.randomUUID(), gameNumber: state.ledger.entries.length + 1,
      players: players.map((player) => ({ playerId: player.id, name: player.name, teamId: teamForPlayer(state, player) })),
      teams: teamIds(state).map((id) => ({ teamId: id, memberPlayerIds: players.filter((player) => teamForPlayer(state, player) === id).map((player) => player.id) })),
      finalTeamScores: { ...state.game.teamScores }, winnerTeamId: teamId, holesBehind,
      result, multiplier, baseGameCents: state.ledger.baseStakeCents,
      perHoleCents: state.ledger.perHoleCents, perPlayerCents, timestamp: Date.now(),
    });
  }
  return true;
}

function legalCards(state: RoomState, player: Player): string[] {
  return (state.game.hands[player.id] ?? []).filter((card) => state.game.runningCount + cardValue(card) <= 31);
}

function resetPeggingSequence(state: RoomState, afterSeat: number): void {
  state.game.runningCount = 0; state.game.sequenceCards = []; state.game.goPlayers = []; state.game.lastPegger = null;
  state.game.turnSeat = nextPlayerWithCards(state, afterSeat)?.seat ?? null;
  if (state.game.turnSeat === null) beginCounting(state);
}

function nextPlayerWithCards(state: RoomState, seat: number): Player | null {
  for (let offset = 1; offset <= state.seatCount; offset += 1) {
    const candidate = seated(state).find((player) => player.seat === (seat + offset) % state.seatCount);
    if (candidate && (state.game.hands[candidate.id]?.length ?? 0) > 0) return candidate;
  }
  return null;
}

function awardLastCard(state: RoomState, player: Player): boolean {
  const teamId = teamForPlayer(state, player);
  const won = award(state, teamId, 1);
  const score = state.game.teamScores[teamId] ?? 0;
  dialogue(state, "PEG_LAST", player.id, undefined, { reason: "last card", points: 1, score, runningCount: state.game.runningCount,
    message: `${player.name} pegs 1 for last card; score ${score}.` });
  return won;
}

function advancePegging(state: RoomState, afterSeat: number): void {
  if (state.game.phase === "complete") return;
  const withCards = seated(state).filter((player) => (state.game.hands[player.id]?.length ?? 0) > 0);
  if (withCards.length === 0) {
    if (state.game.runningCount !== 31 && state.game.lastPegger &&
      awardLastCard(state, state.players.find((p) => p.id === state.game.lastPegger)!)) return;
    beginCounting(state);
    return;
  }
  for (let offset = 1; offset <= state.seatCount; offset += 1) {
    const player = seated(state).find((candidate) => candidate.seat === (afterSeat + offset) % state.seatCount);
    if (!player || !state.game.hands[player.id]?.length || state.game.goPlayers.includes(player.id)) continue;
    state.game.turnSeat = player.seat;
    return;
  }
  if (state.game.lastPegger) {
    const last = state.players.find((player) => player.id === state.game.lastPegger)!;
    if (awardLastCard(state, last)) return;
    resetPeggingSequence(state, last.seat as number);
  }
}

export function scoreHand(cards: string[], starter: string, crib: boolean): number {
  const all = [...cards, starter]; let score = 0;
  for (let mask = 1; mask < 1 << all.length; mask += 1) {
    let sum = 0;
    for (let index = 0; index < all.length; index += 1) if (mask & (1 << index)) sum += cardValue(all[index]!);
    if (sum === 15) score += 2;
  }
  const counts = new Map<number, number>();
  for (const card of all) counts.set(rankNumber(card), (counts.get(rankNumber(card)) ?? 0) + 1);
  for (const count of counts.values()) score += count * (count - 1);
  let bestRun = 0; let runPoints = 0;
  for (let mask = 1; mask < 1 << all.length; mask += 1) {
    const selected = all.filter((_, index) => mask & (1 << index)).map(rankNumber);
    if (selected.length < 3 || new Set(selected).size !== selected.length) continue;
    if (Math.max(...selected) - Math.min(...selected) === selected.length - 1) {
      if (selected.length > bestRun) { bestRun = selected.length; runPoints = selected.length; }
      else if (selected.length === bestRun) runPoints += selected.length;
    }
  }
  score += runPoints;
  const flushSuit = cards[0]?.slice(-1);
  if (cards.every((card) => card.endsWith(flushSuit!)) && (!crib || starter.endsWith(flushSuit!))) {
    score += starter.endsWith(flushSuit!) ? 5 : 4;
  }
  if (cards.some((card) => rankOf(card) === "J" && card.slice(-1) === starter.slice(-1))) score += 1;
  return score;
}

function beginCounting(state: RoomState): void {
  if (state.game.phase === "complete") return;
  state.game.phase = "counting"; state.status = "counting";
  const dealer = state.game.dealerSeat as number;
  const order = Array.from({ length: state.seatCount }, (_, index) => (dealer + 1 + index) % state.seatCount);
  state.game.countQueue = order.map((seat) => {
    const player = seated(state).find((candidate) => candidate.seat === seat)!;
    return { eventId: crypto.randomUUID(), playerId: player.id, teamId: teamForPlayer(state, player), kind: "hand" as const,
      points: scoreHand(state.game.countHands[player.id] ?? [], state.game.starterCard!, false) };
  });
  const dealerPlayer = seated(state).find((player) => player.seat === dealer)!;
  state.game.countQueue.push({ eventId: crypto.randomUUID(), playerId: dealerPlayer.id, teamId: teamForPlayer(state, dealerPlayer),
    kind: "crib", points: scoreHand(state.game.crib, state.game.starterCard!, true) });
  state.game.countIndex = 0; exposeCount(state);
}

function exposeCount(state: RoomState): void {
  const item = state.game.countQueue[state.game.countIndex];
  if (!item) {
    state.game.phase = "dealComplete"; state.status = "playing";
    state.game.pendingEventId = dialogue(state, "DEAL_COMPLETE");
    return;
  }
  state.game.pendingEventId = item.eventId; state.game.acknowledgements = [];
  const player = state.players.find((candidate) => candidate.id === item.playerId);
  const scoreBefore = state.game.teamScores[item.teamId] ?? 0;
  const projectedScore = Math.min(121, scoreBefore + item.points);
  dialogue(state, item.kind === "crib" ? "COUNT_CRIB" : "COUNT_HAND", item.playerId ?? undefined, item.eventId, {
    points: item.points,
    score: projectedScore,
    message: `${player?.name ?? "Player"}'s ${item.kind === "crib" ? "crib" : "hand"} is worth ${item.points} point${item.points === 1 ? "" : "s"}; score ${scoreBefore} -> ${projectedScore}.`,
  });
}

function advanceCount(state: RoomState): void {
  const item = state.game.countQueue[state.game.countIndex];
  if (!item) return;
  const won = award(state, item.teamId, item.points);
  const player = state.players.find((candidate) => candidate.id === item.playerId);
  const score = state.game.teamScores[item.teamId] ?? 0;
  dialogue(state, "COUNT_AWARDED", item.playerId ?? undefined, undefined, { points: item.points, score,
    message: `${player?.name ?? "Player"}'s ${item.kind === "crib" ? "crib" : "hand"} counted ${item.points} point${item.points === 1 ? "" : "s"}; score ${score}.` });
  if (won) return;
  state.game.countIndex += 1; exposeCount(state);
}

function dialogue(state: RoomState, type: string, playerId?: string, forcedId?: string, data?: NonNullable<RoomState["dialogue"][number]["data"]>): string {
  const id = forcedId ?? crypto.randomUUID();
  state.dialogue.push({ id, type, ...(playerId ? { playerId } : {}), ...(data ? { data } : {}), createdAt: Date.now() });
  if (state.dialogue.length > 100) state.dialogue.splice(0, state.dialogue.length - 100);
  return id;
}

function requireUnpaused(state: RoomState): void {
  if (state.game.pausedForPlayerId) throw new ProtocolError("INVALID_STATE", "Play is paused for a disconnected player.");
}

function chooseAiDiscard(state: RoomState, player: Player): string[] {
  const hand = state.game.hands[player.id] ?? [];
  const required = state.seatCount === 2 ? 2 : 1;
  const combinations: string[][] = required === 1 ? hand.map((card) => [card]) :
    hand.flatMap((card, index) => hand.slice(index + 1).map((other) => [card, other]));
  if (player.aiDifficulty === "easy") return combinations[cryptoInt(combinations.length)]!;
  const starterCandidates = makeDeck().filter((card) => !hand.includes(card));
  return combinations.map((discard) => {
    const kept = hand.filter((card) => !discard.includes(card));
    const score = starterCandidates.reduce((sum, starter) => sum + scoreHand(kept, starter, false), 0);
    return { discard, score };
  }).sort((a, b) => b.score - a.score)[0]!.discard;
}

function runAi(state: RoomState): void {
  for (let guard = 0; guard < 100 && state.game.phase !== "complete" && !state.game.pausedForPlayerId; guard += 1) {
    if (state.game.phase === "cut") {
      const eligible = state.game.acknowledgements.length ? state.game.acknowledgements : seated(state).map((p) => p.id);
      const ai = seated(state).find((player) => player.isAI && eligible.includes(player.id) && !state.game.cutCards[player.id]);
      if (!ai) return;
      state.game.cutCards[ai.id] = state.game.deck.pop()!; resolveCut(state); continue;
    }
    if (state.game.phase === "discard") {
      const ai = seated(state).find((player) => player.isAI && (state.game.hands[player.id]?.length ?? 0) > 4);
      if (!ai) return;
      const discard = chooseAiDiscard(state, ai);
      state.game.hands[ai.id] = state.game.hands[ai.id]!.filter((card) => !discard.includes(card));
      state.game.crib.push(...discard);
      if (seated(state).every((player) => state.game.hands[player.id]?.length === 4)) {
        if (state.seatCount === 3) state.game.crib.push(state.game.deck.pop()!);
        state.game.starterCard = state.game.deck.pop()!; state.game.countHands = structuredClone(state.game.hands);
        state.game.phase = "pegging";
        state.game.turnSeat = nextOccupiedSeat(state, state.game.dealerSeat!);
        if (rankOf(state.game.starterCard) === "J") {
          const dealerSeat = state.game.dealerSeat!;
          const dealer = seated(state).find((player) => player.seat === dealerSeat);
          const dealerTeam = teamForSeat(state, dealerSeat);
          award(state, dealerTeam, 2);
          const score = state.game.teamScores[dealerTeam] ?? 0;
          dialogue(state, "STARTER_JACK", dealer?.id, undefined, {
            points: 2,
            score,
            message: `${dealer?.name ?? "Dealer"} scores 2 for his heels (starter jack); score ${score}.`,
          });
        }
      }
      continue;
    }
    if (state.game.phase === "pegging") {
      const ai = seated(state).find((player) => player.isAI && player.seat === state.game.turnSeat);
      if (!ai) return;
      const legal = legalCards(state, ai);
      if (!legal.length) {
        if (!state.game.goPlayers.includes(ai.id)) state.game.goPlayers.push(ai.id);
        const goCount = state.game.runningCount;
        advancePegging(state, ai.seat!);
        const next = seated(state).find((player) => player.seat === state.game.turnSeat);
        dialogue(state, "PEG_GO", ai.id, undefined, { runningCount: goCount, ...(next ? { nextPlayerId: next.id } : {}),
          message: `${ai.name} says Go at ${goCount}.${next ? ` ${next.name}'s turn.` : ""}` });
        continue;
      }
      const card = ai.aiDifficulty === "easy" ? legal[cryptoInt(legal.length)]! :
        legal.map((candidate) => ({ candidate, points: peggingPoints([...state.game.sequenceCards.map((p) => p.card), candidate], state.game.runningCount + cardValue(candidate)) }))
          .sort((a, b) => b.points - a.points)[0]!.candidate;
      state.game.hands[ai.id] = state.game.hands[ai.id]!.filter((item) => item !== card);
      state.game.playedCards.push({ playerId: ai.id, card }); state.game.sequenceCards.push({ playerId: ai.id, card });
      state.game.runningCount += cardValue(card); state.game.lastPegger = ai.id;
      const playedCount = state.game.runningCount;
      const points = peggingPoints(state.game.sequenceCards.map((p) => p.card), playedCount);
      const reason = peggingReason(state.game.sequenceCards.map((p) => p.card), playedCount);
      const aiTeam = teamForPlayer(state, ai);
      if (award(state, aiTeam, points)) {
        const score = state.game.teamScores[aiTeam] ?? 0;
        dialogue(state, "PEG_PLAY", ai.id, undefined, { card, reason, runningCount: playedCount, points, score,
          message: `${ai.name} played ${card}, ${reason}; count ${playedCount}; score ${score}; game complete.` });
        continue;
      }
      if (state.game.runningCount === 31) resetPeggingSequence(state, ai.seat!); else advancePegging(state, ai.seat!);
      const next = seated(state).find((player) => player.seat === state.game.turnSeat);
      const score = state.game.teamScores[aiTeam] ?? 0;
      dialogue(state, "PEG_PLAY", ai.id, undefined, { card, reason, runningCount: playedCount, points, score, ...(next ? { nextPlayerId: next.id } : {}),
        message: `${ai.name} played ${card}, ${reason}; count ${playedCount}; ${points} point${points === 1 ? "" : "s"}; score ${score}.${next ? ` ${next.name}'s turn.` : ""}` });
      continue;
    }
    if (state.game.phase === "counting") {
      const humans = seated(state).filter((player) => !player.isAI);
      if (humans.length === 0) { advanceCount(state); continue; }
    }
    return;
  }
}

function resetForRematch(state: RoomState): void {
  state.status = "lobby"; state.game = initialGame(); state.rematchRequests = [];
  for (const player of state.players) player.ready = player.isAI;
}
