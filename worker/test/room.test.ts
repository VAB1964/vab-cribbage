import { env } from "cloudflare:workers";
import { runDurableObjectAlarm, runInDurableObject } from "cloudflare:test";
import { beforeEach, describe, expect, it } from "vitest";
import { type Command, type CommandResult, parseCommand } from "../src/protocol";
import { GameRoom } from "../src/game-room";

let roomId: string;
let stub: DurableObjectStub<GameRoom>;
let revision: number;

function command(type: string, payload: unknown, playerId: string | null = null, commandId: string = crypto.randomUUID(), expected = revision): Command {
  return parseCommand({ protocolVersion: 1, roomId, playerId, commandId, expectedRevision: expected, type, payload });
}

async function send(type: string, payload: unknown, playerId: string | null = null, commandId?: string, expected?: number): Promise<CommandResult> {
  const result = await stub.executeForTest(command(type, payload, playerId, commandId, expected));
  if (result.ok) revision = result.revision;
  return result;
}

function acceptedData(result: CommandResult): Record<string, unknown> {
  expect(result.ok).toBe(true);
  return result.ok ? result.event.data as Record<string, unknown> : {};
}

async function createHost(name = "Host"): Promise<{ id: string; token: string }> {
  const data = acceptedData(await send("CREATE_ROOM", { name, avatarId: "m-1", seatCount: 2 }));
  return { id: String(data.playerId), token: String(data.reconnectToken) };
}

async function finishCut(playerIds: string[]): Promise<void> {
  for (let guard = 0; guard < 20; guard += 1) {
    const view = await stub.viewForTest(playerIds[0]!);
    if (view?.game.phase !== "cut") return;
    const eligible = view.game.acknowledgements.length ? view.game.acknowledgements : playerIds;
    for (const id of eligible) {
      const current = await stub.viewForTest(id);
      if (current?.game.phase === "cut" && !current.game.cutCards[id]) acceptedData(await send("CUT_CARD", {}, id));
    }
  }
  throw new Error("Cut did not resolve");
}

beforeEach(async () => {
  roomId = `T${crypto.randomUUID().replaceAll("-", "").slice(0, 5).toUpperCase()}`.replace(/[IO01]/g, "A");
  stub = env.GAME_ROOMS.getByName(roomId);
  revision = 0;
  expect(await stub.initialize(roomId)).toBe(true);
});

describe("GameRoom authority", () => {
  it("creates, joins, and rejects a full room", async () => {
    await createHost();
    acceptedData(await send("JOIN_ROOM", { name: "Guest", avatarId: "f-2" }));
    const full = await send("JOIN_ROOM", { name: "Third", avatarId: "g-3" });
    expect(full).toMatchObject({ ok: false, error: { code: "ROOM_FULL" } });
  });

  it("gates start on readiness and host authority", async () => {
    const host = await createHost();
    const guest = acceptedData(await send("JOIN_ROOM", { name: "Guest", avatarId: "f-2" }));
    const guestId = String(guest.playerId);
    expect(await send("START_GAME", {}, guestId)).toMatchObject({ ok: false, error: { code: "FORBIDDEN" } });
    acceptedData(await send("SET_READY", { ready: true }, host.id));
    expect(await send("START_GAME", {}, host.id)).toMatchObject({ ok: false, error: { code: "INVALID_STATE" } });
    acceptedData(await send("SET_READY", { ready: true }, guestId));
    expect(await send("START_GAME", {}, host.id)).toMatchObject({ ok: true, event: { type: "START_GAME_ACCEPTED" } });
  });

  it("rejects stale commands and caches duplicate results", async () => {
    const host = await createHost();
    const stale = await stub.executeForTest(command("SET_READY", { ready: true }, host.id, crypto.randomUUID(), 0));
    expect(stale).toMatchObject({ ok: false, error: { code: "STALE_REVISION" } });
    const id = crypto.randomUUID();
    const first = await send("SET_READY", { ready: true }, host.id, id);
    const duplicate = await stub.executeForTest(command("SET_READY", { ready: false }, host.id, id, 0));
    expect(duplicate).toEqual(first);
  });

  it("reconnects only with the secret token", async () => {
    const host = await createHost();
    await stub.disconnectForTest(host.id);
    revision += 1;
    const bad = await send("JOIN_ROOM", { name: "Host", avatarId: "m-1", reconnectToken: "x".repeat(64) }, host.id);
    expect(bad).toMatchObject({ ok: false, error: { code: "UNAUTHORIZED" } });
    const good = await send("JOIN_ROOM", { name: "Host", avatarId: "m-1", reconnectToken: host.token }, host.id);
    expect(good).toMatchObject({ ok: true, event: { data: { reconnected: true } } });
  });

  it("reconnects to the same private seat while a game is active", async () => {
    const host = await createHost();
    const guestId = String(acceptedData(await send("JOIN_ROOM", { name: "Guest", avatarId: "f-2" })).playerId);
    acceptedData(await send("SET_READY", { ready: true }, host.id));
    acceptedData(await send("SET_READY", { ready: true }, guestId));
    acceptedData(await send("START_GAME", {}, host.id));
    await stub.disconnectForTest(host.id);
    revision += 1;
    const result = await stub.executeForTest(command("JOIN_ROOM", { name: "Host", avatarId: "m-1", reconnectToken: host.token }, host.id, crypto.randomUUID(), revision - 1));
    if (result.ok) revision = result.revision;
    expect(result).toMatchObject({ ok: true, event: { data: { playerId: host.id, reconnected: true } } });
    expect((await stub.viewForTest(host.id))?.status).toBe("playing");
  });

  it("redacts opponent hands and all token hashes", async () => {
    const host = await createHost();
    const guestId = String(acceptedData(await send("JOIN_ROOM", { name: "Guest", avatarId: "f-2" })).playerId);
    acceptedData(await send("SET_READY", { ready: true }, host.id));
    acceptedData(await send("SET_READY", { ready: true }, guestId));
    acceptedData(await send("START_GAME", {}, host.id));
    await finishCut([host.id, guestId]);
    const view = await stub.viewForTest(host.id);
    expect(view?.game.hand).toHaveLength(6);
    expect(view?.game.handCounts[guestId]).toBe(6);
    expect(view?.game).not.toHaveProperty("hands");
    expect(view?.game).not.toHaveProperty("countHands");
    expect(view?.game).not.toHaveProperty("deck");
    expect(view?.game.crib).toBeNull();
    expect(JSON.stringify(view)).not.toContain("reconnectTokenHash");
    expect(JSON.stringify(view)).not.toContain(host.token);
  });

  it("requires exact distinct discards and cuts the starter only after every player discards", async () => {
    const host = await createHost();
    const guestId = String(acceptedData(await send("JOIN_ROOM", { name: "Guest", avatarId: "f-2" })).playerId);
    acceptedData(await send("SET_READY", { ready: true }, host.id));
    acceptedData(await send("SET_READY", { ready: true }, guestId));
    acceptedData(await send("START_GAME", {}, host.id));
    await finishCut([host.id, guestId]);
    const hostHand = (await stub.viewForTest(host.id))?.game.hand ?? [];
    expect(await send("DISCARD", { cards: [hostHand[0]] }, host.id)).toMatchObject({ ok: false, error: { code: "INVALID_ACTION" } });
    expect(await send("DISCARD", { cards: [hostHand[0], hostHand[0]] }, host.id)).toMatchObject({ ok: false, error: { code: "INVALID_ACTION" } });
    acceptedData(await send("DISCARD", { cards: hostHand.slice(0, 2) }, host.id));
    expect((await stub.viewForTest(host.id))?.game.starterCard).toBeNull();
    const guestHand = (await stub.viewForTest(guestId))?.game.hand ?? [];
    acceptedData(await send("DISCARD", { cards: guestHand.slice(0, 2) }, guestId));
    const completed = await stub.viewForTest(host.id);
    expect(completed?.game).toMatchObject({ cribCount: 4, hand: expect.any(Array) });
    expect(completed?.game.hand).toHaveLength(4);
    expect(completed?.game.starterCard).not.toBeNull();
    expect(completed?.game.crib).toBeNull();
  });

  it("migrates host to the longest-connected remaining human", async () => {
    const host = await createHost();
    const guestId = String(acceptedData(await send("JOIN_ROOM", { name: "Guest", avatarId: "f-2" })).playerId);
    await stub.disconnectForTest(host.id);
    revision += 1;
    expect(await runDurableObjectAlarm(stub)).toBe(true);
    expect((await stub.viewForTest(guestId))?.hostPlayerId).toBe(guestId);
  });

  it("persists snapshots in SQLite for restoration", async () => {
    const host = await createHost("Persistent Host");
    await runInDurableObject(stub, async (instance, state) => {
      expect(instance).toBeInstanceOf(GameRoom);
      const row = state.storage.sql.exec<{ state_json: string }>(
        "SELECT state_json FROM room_snapshot WHERE singleton = 1",
      ).one();
      const restored = JSON.parse(row.state_json) as { hostPlayerId: string; revision: number };
      expect(restored.hostPlayerId).toBe(host.id);
      expect(restored.revision).toBe(revision);
    });
  });

  it("completes an authoritative game, records a zero-sum ledger, and rematches", async () => {
    const host = await createHost();
    const guestId = String(acceptedData(await send("JOIN_ROOM", { name: "Guest", avatarId: "f-2" })).playerId);
    acceptedData(await send("UPDATE_LEDGER", { enabled: true, baseStakeCents: 100, perHoleCents: 5 }, host.id));
    acceptedData(await send("SET_READY", { ready: true }, host.id));
    acceptedData(await send("SET_READY", { ready: true }, guestId));
    acceptedData(await send("START_GAME", {}, host.id));
    const ids = [host.id, guestId];
    for (let guard = 0; guard < 10_000; guard += 1) {
      const view = await stub.viewForTest(host.id);
      if (!view) throw new Error("Room disappeared");
      if (view.status === "complete") break;
      if (view.game.phase === "cut") {
        await finishCut(ids);
      } else if (view.game.phase === "discard") {
        for (const id of ids) {
          const privateView = await stub.viewForTest(id);
          if (privateView?.game.hand.length === 6) acceptedData(await send("DISCARD", { cards: privateView.game.hand.slice(0, 2) }, id));
        }
      } else if (view.game.phase === "pegging") {
        const actor = view.players.find((player) => player.seat === view.game.turnSeat);
        if (!actor) throw new Error("No pegging actor");
        const privateView = await stub.viewForTest(actor.id);
        const legal = privateView?.game.hand.find((card) => {
          const rank = card.slice(0, -1);
          const value = rank === "A" ? 1 : ["J", "Q", "K"].includes(rank) ? 10 : Number(rank);
          return value + (privateView?.game.runningCount ?? 0) <= 31;
        });
        acceptedData(await send(legal ? "PLAY_CARD" : "SAY_GO", legal ? { card: legal } : {}, actor.id));
      } else if (view.game.phase === "counting") {
        for (const id of ids) {
          const current = await stub.viewForTest(id);
          if (current?.game.phase === "counting" && current.game.pendingEventId && !current.game.acknowledgements.includes(id)) {
            acceptedData(await send("ACK_COUNT", { eventId: current.game.pendingEventId }, id));
          }
        }
      } else if (view.game.phase === "dealComplete") {
        acceptedData(await send("NEXT_DEAL", { eventId: view.game.pendingEventId }, host.id));
      }
    }
    const completed = await stub.viewForTest(host.id);
    expect(completed?.status).toBe("complete");
    expect(completed?.game.winnerTeamId).toBeTruthy();
    expect(completed?.ledger.entries).toHaveLength(1);
    const entry = completed!.ledger.entries[0]!;
    expect(Object.values(entry.perPlayerCents).reduce((sum, amount) => sum + amount, 0)).toBe(0);
    expect(entry.multiplier).toBe([1, 2, 4].find((value) => value === entry.multiplier));
    acceptedData(await send("REMATCH", {}, host.id));
    expect((await stub.viewForTest(host.id))?.status).toBe("lobby");
  }, 30_000);

  it("supports three humans plus one AI with equal partnership settlement", async () => {
    const hostData = acceptedData(await send("CREATE_ROOM", { name: "Host", avatarId: "m-1", seatCount: 4 }));
    const hostId = String(hostData.playerId);
    const guestOne = String(acceptedData(await send("JOIN_ROOM", { name: "Guest 1", avatarId: "f-1" })).playerId);
    const guestTwo = String(acceptedData(await send("JOIN_ROOM", { name: "Guest 2", avatarId: "f-2" })).playerId);
    acceptedData(await send("ASSIGN_TEAM", { targetPlayerId: hostId, teamId: "gold" }, hostId));
    acceptedData(await send("ASSIGN_TEAM", { targetPlayerId: guestOne, teamId: "green" }, hostId));
    acceptedData(await send("ASSIGN_TEAM", { targetPlayerId: guestTwo, teamId: "gold" }, hostId));
    acceptedData(await send("ADD_AI", { seat: 3, difficulty: "hard" }, hostId));
    acceptedData(await send("UPDATE_LEDGER", { enabled: true, baseStakeCents: 100, perHoleCents: 10 }, hostId));
    for (const id of [hostId, guestOne, guestTwo]) acceptedData(await send("SET_READY", { ready: true }, id));
    acceptedData(await send("START_GAME", {}, hostId));
    const humans = [hostId, guestOne, guestTwo];
    for (let guard = 0; guard < 12_000; guard += 1) {
      const view = await stub.viewForTest(hostId);
      if (!view) throw new Error("Room disappeared");
      if (view.status === "complete") break;
      if (view.game.phase === "cut") {
        for (const id of humans) {
          const current = await stub.viewForTest(id);
          if (current?.game.phase === "cut" && !current.game.cutCards[id] &&
            (!current.game.acknowledgements.length || current.game.acknowledgements.includes(id))) {
            acceptedData(await send("CUT_CARD", {}, id));
          }
        }
      } else if (view.game.phase === "discard") {
        for (const id of humans) {
          const current = await stub.viewForTest(id);
          if (current?.game.hand.length === 5) acceptedData(await send("DISCARD", { cards: current.game.hand.slice(0, 1) }, id));
        }
      } else if (view.game.phase === "pegging") {
        const actor = view.players.find((player) => player.seat === view.game.turnSeat);
        if (!actor || actor.isAI) continue;
        const current = await stub.viewForTest(actor.id);
        const legal = current?.game.hand.find((card) => {
          const rank = card.slice(0, -1);
          const value = rank === "A" ? 1 : ["J", "Q", "K"].includes(rank) ? 10 : Number(rank);
          return value + (current?.game.runningCount ?? 0) <= 31;
        });
        acceptedData(await send(legal ? "PLAY_CARD" : "SAY_GO", legal ? { card: legal } : {}, actor.id));
      } else if (view.game.phase === "counting") {
        for (const id of humans) {
          const current = await stub.viewForTest(id);
          if (current?.game.phase === "counting" && current.game.pendingEventId && !current.game.acknowledgements.includes(id)) {
            acceptedData(await send("ACK_COUNT", { eventId: current.game.pendingEventId }, id));
          }
        }
      } else if (view.game.phase === "dealComplete") {
        acceptedData(await send("NEXT_DEAL", { eventId: view.game.pendingEventId }, hostId));
      }
    }
    const entry = (await stub.viewForTest(hostId))?.ledger.entries[0];
    expect(entry).toBeTruthy();
    const gold = entry!.teams.find((team) => team.teamId === "gold")!.memberPlayerIds.map((id) => entry!.perPlayerCents[id]);
    const green = entry!.teams.find((team) => team.teamId === "green")!.memberPlayerIds.map((id) => entry!.perPlayerCents[id]);
    expect(new Set(gold).size).toBe(1);
    expect(new Set(green).size).toBe(1);
    expect(Object.values(entry!.perPlayerCents).reduce((sum, amount) => sum + amount, 0)).toBe(0);
  }, 30_000);
});
