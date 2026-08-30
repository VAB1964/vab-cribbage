import { describe, expect, it } from "vitest";
import { MAX_MESSAGE_BYTES, PROTOCOL_VERSION, ProtocolError, parseCommandText } from "../src/protocol";

const valid = {
  protocolVersion: PROTOCOL_VERSION,
  roomId: "ABC234",
  playerId: null,
  commandId: "00000000-0000-4000-8000-000000000001",
  expectedRevision: 0,
  type: "JOIN_ROOM",
  payload: { name: "Vince", avatarId: "m-1" },
};

describe("protocol parsing", () => {
  it("accepts a strict valid command", () => {
    expect(parseCommandText(JSON.stringify(valid))).toMatchObject({ type: "JOIN_ROOM", roomId: "ABC234" });
  });

  it("rejects malformed, unknown, and version-mismatched messages", () => {
    expect(() => parseCommandText("{")).toThrow(ProtocolError);
    expect(() => parseCommandText(JSON.stringify({ ...valid, surprise: true }))).toThrow("schema validation");
    expect(() => parseCommandText(JSON.stringify({ ...valid, protocolVersion: 99 }))).toThrow("Unsupported protocol");
  });

  it("enforces the encoded payload limit", () => {
    expect(() => parseCommandText("x".repeat(MAX_MESSAGE_BYTES + 1))).toThrow("16 KiB");
  });
});
