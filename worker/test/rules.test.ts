import { describe, expect, it } from "vitest";
import { cutRank, peggingPoints, scoreHand } from "../src/game-room";

describe("authoritative cribbage scoring", () => {
  it("orders cut cards low to high with ace low", () => {
    expect(["KC", "10D", "2S", "AH"].sort((left, right) => cutRank(left) - cutRank(right))).toEqual(["AH", "2S", "10D", "KC"]);
  });

  it("scores pegging fifteens, 31s, pairs, triples, quads, and suffix runs", () => {
    expect(peggingPoints(["5C", "10D"], 15)).toBe(2);
    expect(peggingPoints(["10C", "10D", "10H", "AS"], 31)).toBe(2);
    expect(peggingPoints(["7C", "7D"], 14)).toBe(2);
    expect(peggingPoints(["7C", "7D", "7H"], 21)).toBe(6);
    expect(peggingPoints(["5C", "5D", "5H", "5S"], 20)).toBe(12);
    expect(peggingPoints(["9C", "4D", "6H", "5S"], 24)).toBe(3);
    expect(peggingPoints(["3C", "4D", "5H", "6S"], 18)).toBe(4);
  });

  it("scores canonical 29 hand and crib flush restriction", () => {
    expect(scoreHand(["5C", "5D", "5H", "JS"], "5S", false)).toBe(29);
    expect(scoreHand(["2H", "4H", "6H", "8H"], "KC", false)).toBe(4);
    expect(scoreHand(["2H", "4H", "6H", "8H"], "KC", true)).toBe(0);
  });
});
