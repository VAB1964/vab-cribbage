import { describe, expect, it } from "vitest";
import {
  addTeamScore, card, cardValue, classifyLoss, createDeck, createTeams, dealPlan, isCard,
  ledgerTotals, legalPeggingActions, nextDealerSeat, scoreHand, scoreHeels, scorePeggingPlay,
  scoreSequenceEnd, settleGame, shuffle, skunkMultiplier, teamForSeat, transition, winningTeam,
  type Card, type DeterministicGameState,
} from "./index";

const c = (rank: Card["rank"], suit: Card["suit"] = "clubs") => card(rank, suit);

describe("cards and deck", () => {
  it("creates all 52 unique cards with cribbage values", () => {
    const deck = createDeck();
    expect(deck).toHaveLength(52);
    expect(new Set(deck.map(item => item.id))).toHaveLength(52);
    expect([c(1), c(10), c(11), c(12), c(13)].map(cardValue)).toEqual([1, 10, 10, 10, 10]);
    expect(isCard(c(13, "spades"))).toBe(true);
    expect(isCard({ rank: 14, suit: "spades", id: "14-spades" })).toBe(false);
  });

  it("performs deterministic Fisher-Yates without changing its input", () => {
    const input = [1, 2, 3, 4];
    expect(shuffle(input, () => 0)).toEqual([2, 3, 4, 1]);
    expect(input).toEqual([1, 2, 3, 4]);
    expect(shuffle(input, () => 0.999999)).toEqual(input);
  });

  it("rejects invalid injected RNG values", () => {
    expect(() => shuffle([1, 2], () => 1)).toThrow(RangeError);
    expect(() => shuffle([1, 2], () => -0.1)).toThrow(RangeError);
    expect(() => shuffle([1, 2], () => Number.NaN)).toThrow(RangeError);
  });
});

describe("hand scoring", () => {
  it("scores every distinct fifteen combination", () => {
    const score = scoreHand([c(5), c(5, "diamonds"), c(5, "hearts"), c(11, "spades")], c(5, "spades"));
    expect(score.fifteens).toBe(16);
    expect(score.events.filter(event => event.category === "fifteen")).toHaveLength(8);
  });

  it("scores pairs, triples, and quads as all constituent pairs", () => {
    expect(scoreHand([c(7), c(7, "diamonds"), c(2), c(9)], c(13)).pairs).toBe(2);
    expect(scoreHand([c(7), c(7, "diamonds"), c(7, "hearts"), c(9)], c(13)).pairs).toBe(6);
    expect(scoreHand([c(7), c(7, "diamonds"), c(7, "hearts"), c(7, "spades")], c(13)).pairs).toBe(12);
  });

  it("scores only maximal runs and preserves duplicate-run multiplicity", () => {
    expect(scoreHand([c(1), c(2), c(3), c(4)], c(5)).runs).toBe(5);
    const doubleRun = scoreHand([c(3), c(3, "diamonds"), c(4), c(5)], c(6));
    expect(doubleRun.runs).toBe(8);
    expect(doubleRun.events.filter(event => event.category === "run")).toHaveLength(2);
    expect(scoreHand([c(2), c(3), c(4), c(4, "diamonds")], c(5)).runs).toBe(8);
  });

  it("applies hand and crib flush rules", () => {
    const hand = [c(1, "hearts"), c(3, "hearts"), c(7, "hearts"), c(9, "hearts")];
    expect(scoreHand(hand, c(13, "spades")).flush).toBe(4);
    expect(scoreHand(hand, c(13, "spades"), true).flush).toBe(0);
    expect(scoreHand(hand, c(13, "hearts"), true).flush).toBe(5);
    expect(scoreHand([c(1), c(3), c(7), c(9, "hearts")], c(13, "clubs")).flush).toBe(0);
  });

  it("scores nobs, heels, and the canonical 29 hand", () => {
    expect(scoreHand([c(11, "hearts"), c(2), c(6), c(9)], c(13, "hearts")).nobs).toBe(1);
    expect(scoreHeels(c(11))).toBe(2);
    expect(scoreHeels(c(10))).toBe(0);
    expect(scoreHand([c(5), c(5, "diamonds"), c(5, "hearts"), c(11, "spades")], c(5, "spades")).total).toBe(29);
  });

  it("rejects malformed counted hands", () => {
    expect(() => scoreHand([c(1), c(2), c(3)], c(4))).toThrow(RangeError);
  });
});

describe("pegging", () => {
  it("identifies legal plays and makes Go the only action when blocked", () => {
    expect(legalPeggingActions([c(5), c(10)], 25)).toEqual([{ type: "play", card: c(5) }]);
    expect(legalPeggingActions([c(7), c(10)], 25)).toEqual([{ type: "go" }]);
  });

  it("scores 15 and 31", () => {
    expect(scorePeggingPlay([c(10)], c(5), 10)).toContainEqual({ kind: "fifteen", points: 2 });
    expect(scorePeggingPlay([c(10), c(10)], c(1), 30)).toContainEqual({ kind: "thirtyOne", points: 2 });
    expect(() => scorePeggingPlay([], c(2), 30)).toThrow(RangeError);
  });

  it("scores consecutive pairs, triples, and quads", () => {
    expect(scorePeggingPlay([c(8)], c(8, "hearts"), 8)).toContainEqual({ kind: "pair", points: 2 });
    expect(scorePeggingPlay([c(8), c(8, "hearts")], c(8, "spades"), 16)).toContainEqual({ kind: "triple", points: 6 });
    expect(scorePeggingPlay([c(3), c(3, "hearts"), c(3, "spades")], c(3, "diamonds"), 9)).toContainEqual({ kind: "quad", points: 12 });
    expect(scorePeggingPlay([c(8), c(7), c(8, "hearts")], c(8, "spades"), 23).some(score => score.kind === "triple")).toBe(false);
  });

  it("scores the longest trailing run in any play order", () => {
    expect(scorePeggingPlay([c(3), c(5)], c(4), 8)).toContainEqual({ kind: "run", points: 3 });
    expect(scorePeggingPlay([c(7), c(3), c(5), c(4)], c(6), 19)).toContainEqual({ kind: "run", points: 5 });
    expect(scorePeggingPlay([c(3), c(4), c(4, "hearts")], c(5), 11).some(score => score.kind === "run")).toBe(false);
  });

  it("scores Go and last card, but adds nothing after 31", () => {
    expect(scoreSequenceEnd(27, false)).toEqual({ kind: "go", points: 1 });
    expect(scoreSequenceEnd(27, true)).toEqual({ kind: "lastCard", points: 1 });
    expect(scoreSequenceEnd(31, true).points).toBe(0);
  });
});

describe("dealing and teams", () => {
  it("defines exact 2/3/4-player deal plans and dealer rotation", () => {
    expect(dealPlan(2)).toMatchObject({ cardsPerPlayer: 6, discardsPerPlayer: 2, kittyCards: 0, cribSize: 4 });
    expect(dealPlan(3)).toMatchObject({ cardsPerPlayer: 5, discardsPerPlayer: 1, kittyCards: 1, cribSize: 4 });
    expect(dealPlan(4)).toMatchObject({ cardsPerPlayer: 5, discardsPerPlayer: 1, kittyCards: 0, cribSize: 4 });
    expect(nextDealerSeat(3, 4)).toBe(0);
  });

  it("uses two alternating shared teams for four players", () => {
    const teams = createTeams(4);
    expect(teams).toHaveLength(2);
    expect(teamForSeat(teams, 0)).toBe(teamForSeat(teams, 2));
    expect(teamForSeat(teams, 1)).toBe(teamForSeat(teams, 3));
    const scored = addTeamScore(teams, "team-0", 4);
    expect(teamForSeat(scored, 0).score).toBe(4);
    expect(teamForSeat(scored, 2).score).toBe(4);
    expect(teams[0].score).toBe(0);
  });

  it("caps scores and detects a winner", () => {
    const teams = addTeamScore(createTeams(2), "team-1", 125);
    expect(teams[1].score).toBe(121);
    expect(winningTeam(teams)?.id).toBe("team-1");
  });
});

describe("skunks and Session Ledger", () => {
  it("classifies exact standard boundaries", () => {
    expect([classifyLoss(91), classifyLoss(90), classifyLoss(61), classifyLoss(60)]).toEqual(["normal", "skunk", "skunk", "doubleSkunk"]);
    expect(["normal", "skunk", "doubleSkunk"].map(value => skunkMultiplier(value as never))).toEqual([1, 2, 4]);
  });

  it("settles individual games entirely in integer cents", () => {
    const entry = settleGame({ gameNumber: 1, winnerIds: ["a"], loserIds: ["b"], winnerScore: 121, loserScore: 113,
      result: "normal", stakes: { gameCents: 100, perHoleCents: 5, maximumGameCents: 500 }, timestamp: "2026-01-01T00:00:00Z" });
    expect(entry.holesBehind).toBe(8);
    expect(entry.amountsCents).toEqual({ a: 140, b: -140 });
    expect(Object.isFrozen(entry)).toBe(true);
  });

  it("charges every loser and awards their combined amount to a three-player winner", () => {
    const entry = settleGame({ gameNumber: 1, winnerIds: ["a"], loserIds: ["b", "c"], winnerScore: 121, loserScore: 113,
      result: "normal", stakes: { gameCents: 100, perHoleCents: 5, maximumGameCents: 2000 }, timestamp: "now" });
    expect(entry.amountsCents).toEqual({ b: -140, c: -140, a: 280 });
    expect(Object.values(entry.amountsCents).reduce((sum, amount) => sum + amount, 0)).toBe(0);
  });

  it("applies skunk multipliers and equal partnership amounts", () => {
    const entry = settleGame({ gameNumber: 1, winnerIds: ["v", "a"], loserIds: ["m", "c"], winnerScore: 121, loserScore: 113,
      result: "doubleSkunk", stakes: { gameCents: 100, perHoleCents: 5, maximumGameCents: 500 }, timestamp: "now" });
    expect(entry.amountPerLoserCents).toBe(560);
    expect(entry.amountsCents).toEqual({ m: -560, c: -560, v: 560, a: 560 });
    expect(Object.values(entry.amountsCents).reduce((sum, amount) => sum + amount, 0)).toBe(0);
  });

  it("totals multiple immutable entries and remains zero-sum", () => {
    const common = { winnerScore: 121, loserScore: 120, result: "normal" as const,
      stakes: { gameCents: 100, perHoleCents: 5 as const, maximumGameCents: 500 }, timestamp: "now" };
    const totals = ledgerTotals([
      settleGame({ ...common, gameNumber: 1, winnerIds: ["a"], loserIds: ["b"] }),
      settleGame({ ...common, gameNumber: 2, winnerIds: ["b"], loserIds: ["a"] }),
    ]);
    expect(totals).toEqual({ a: 0, b: 0 });
  });

  it("enforces the configurable cap, allowed rates, safe integers, and divisible winner shares", () => {
    const base = { gameNumber: 1, winnerIds: ["a"], loserIds: ["b"], winnerScore: 121, loserScore: 100,
      result: "normal" as const, timestamp: "now" };
    expect(() => settleGame({ ...base, stakes: { gameCents: 501, perHoleCents: 5, maximumGameCents: 500 } })).toThrow("maximum");
    expect(() => settleGame({ ...base, stakes: { gameCents: 1.5, perHoleCents: 5, maximumGameCents: 500 } })).toThrow("integer");
    expect(() => settleGame({ ...base, stakes: { gameCents: 100, perHoleCents: 7 as never, maximumGameCents: 500 } })).toThrow("per-hole");
    expect(() => settleGame({ ...base, winnerIds: ["a", "c"], stakes: { gameCents: 100, perHoleCents: 5, maximumGameCents: 500 } })).toThrow("divided");
  });
});

describe("deterministic transitions", () => {
  const initial = (phase: DeterministicGameState["phase"]): DeterministicGameState => ({
    revision: 0, phase, playerCount: 2, dealerSeat: 0, turnSeat: 0, teams: createTeams(2), runningCount: 0, sequence: [],
  });

  it("advances deterministic pegging state without mutation", () => {
    const before = initial("pegging");
    const after = transition(before, { type: "play", seat: 0, card: c(10) });
    expect(after).toMatchObject({ revision: 1, runningCount: 10, turnSeat: 1, lastPeggerSeat: 0 });
    expect(before.runningCount).toBe(0);
    expect(transition(after, { type: "resetPeggingSequence", nextSeat: 0 })).toMatchObject({ runningCount: 0, sequence: [], revision: 2 });
  });

  it.each(["pegging", "counting"] as const)("ends immediately when scoring reaches 121 during %s", phase => {
    const nearWin = { ...initial(phase), teams: addTeamScore(createTeams(2), "team-0", 120) };
    expect(transition(nearWin, { type: "score", seat: 0, points: 1 })).toMatchObject({ phase: "complete", winnerTeamId: "team-0" });
  });

  it("rejects out-of-turn play and any action after completion", () => {
    expect(() => transition(initial("pegging"), { type: "play", seat: 1, card: c(2) })).toThrow("Illegal");
    expect(() => transition({ ...initial("complete"), winnerTeamId: "team-0" }, { type: "score", seat: 0, points: 1 })).toThrow("complete");
  });
});
