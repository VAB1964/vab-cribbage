import { describe, expect, it, vi } from "vitest";
import { createCommand, PROTOCOL_VERSION } from "./protocol";
import { parseRoomMessage } from "../controllers/MultiplayerController";

describe("multiplayer command envelopes", () => {
  it("includes version, identity, revision, type, and payload", () => {
    vi.stubGlobal("crypto", { randomUUID: () => "command-123" });
    const command = createCommand("SET_READY", { ready: true }, {
      roomId: "7KQ4MT",
      playerId: "player-1",
      expectedRevision: 12,
    });

    expect(command).toEqual({
      protocolVersion: PROTOCOL_VERSION,
      roomId: "7KQ4MT",
      playerId: "player-1",
      commandId: "command-123",
      expectedRevision: 12,
      type: "SET_READY",
      payload: { ready: true },
    });
    vi.unstubAllGlobals();
  });
});

describe("room message parsing", () => {
  it("accepts extensible authoritative player views", () => {
    const message = parseRoomMessage({
      type: "STATE",
      view: { roomId: "7KQ4MT", revision: 9, phase: "pegging", futureExtension: { enabled: true } },
      events: [{ id: "event-1", type: "CARD_PLAYED", data: { cardId: "5-hearts" } }],
    });
    expect(message?.view?.revision).toBe(9);
    expect(message?.events?.[0].type).toBe("CARD_PLAYED");
  });

  it.each([
    null,
    [],
    { type: 4 },
    { type: "STATE", view: { revision: "nine" } },
    { event: { type: "DIALOGUE", data: "not-an-object" } },
  ])("rejects malformed transport values", value => {
    expect(parseRoomMessage(value)).toBeNull();
  });
});
