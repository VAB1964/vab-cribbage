import { describe, expect, it } from "vitest";
import {
  buildPublicScores,
  buildTableTalkContext,
  buildTableTalkParticipants,
  toPublicCard,
} from "./context";

describe("table talk context builders", () => {
  it("includes only named AI participants with personalities", () => {
    const participants = buildTableTalkParticipants(
      [
        { name: "You", color: "red", score: 0, team: 0 },
        { name: "Mabel", color: "blue", score: 0, team: 1 },
        { name: "Arthur", color: "green", score: 0, team: 2 },
        { name: "Guest", color: "blue", score: 0, team: 3 },
      ],
      4,
    );

    expect(participants.map(item => item.name)).toEqual(["Mabel", "Arthur"]);
  });

  it("builds public score data without hidden card state", () => {
    const playersWithHiddenState = [
      { name: "You", color: "red", score: 12, team: 0, hand: [{ rank: 5, suit: "♣" }] },
      { name: "Mabel", color: "blue", score: 14, team: 1, hand: [{ rank: 1, suit: "♠" }] },
      { name: "Arthur", color: "green", score: 9, team: 2, hand: [{ rank: 13, suit: "♥" }] },
    ] as Array<{ name: string; color: string; score: number; team: number; hand: Array<{ rank: number; suit: string }> }>;

    const scores = buildPublicScores(playersWithHiddenState, 3);
    expect(scores).toEqual([
      { playerIndex: 0, team: 0, name: "You", score: 12 },
      { playerIndex: 1, team: 1, name: "Mabel", score: 14 },
      { playerIndex: 2, team: 2, name: "Arthur", score: 9 },
    ]);
    expect(JSON.stringify(scores)).not.toContain("hand");
  });

  it("context never includes hidden cards from player snapshots", () => {
    const context = buildTableTalkContext({
      level: "chatty",
      playerCount: 3,
      dealerIndex: 1,
      runningCount: 18,
      players: [
        { name: "You", color: "red", score: 50, team: 0, hand: [{ rank: 7, suit: "♦" }] } as never,
        { name: "Mabel", color: "blue", score: 52, team: 1, hand: [{ rank: 2, suit: "♣" }] } as never,
        { name: "Arthur", color: "green", score: 49, team: 2, hand: [{ rank: 6, suit: "♠" }] } as never,
      ],
    });

    expect(context.playerCount).toBe(3);
    expect(context.runningCount).toBe(18);
    expect(JSON.stringify(context)).not.toContain("hand");
  });

  it("exposes only public card rank and suit when requested", () => {
    const publicCard = toPublicCard({
      rank: 11,
      suit: "♦",
    });
    expect(publicCard).toEqual({ rank: 11, suit: "♦" });
    expect(Object.keys(publicCard)).toEqual(["rank", "suit"]);
  });
});
