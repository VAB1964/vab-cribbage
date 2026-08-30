import { describe, expect, it } from "vitest";
import { TableTalkService } from "./service";
import type { CharacterDialogueEmission, TableTalkContext, TableTalkEvent } from "./types";

function baseContext(level: "off" | "occasional" | "chatty" = "chatty"): TableTalkContext {
  return {
    level,
    playerCount: 3,
    dealerIndex: 1,
    runningCount: 12,
    scores: [
      { playerIndex: 0, team: 0, name: "You", score: 32 },
      { playerIndex: 1, team: 1, name: "Mabel", score: 31 },
      { playerIndex: 2, team: 2, name: "Arthur", score: 33 },
    ],
    participants: [
      { playerIndex: 1, team: 1, name: "Mabel", color: "blue", characterId: "mabel" },
      { playerIndex: 2, team: 2, name: "Arthur", color: "green", characterId: "arthur" },
    ],
  };
}

function event(type: TableTalkEvent["type"]): TableTalkEvent {
  if (type === "card_played") return { type, actorIndex: 0, card: { rank: 5, suit: "♣" }, runningTotal: 15 };
  if (type === "pegging_scored") return { type, actorIndex: 1, points: 2, kind: "fifteen", runningTotal: 15 };
  if (type === "large_hand_scored") return { type, actorIndex: 1, points: 10 };
  if (type === "game_started") return { type };
  if (type === "go_declared") return { type, actorIndex: 1 };
  if (type === "first_crib_won") return { type, dealerIndex: 1 };
  throw new Error(`Unsupported test event: ${type}`);
}

describe("TableTalkService", () => {
  it("emits no dialogue when Table Talk is off", () => {
    const emissions: CharacterDialogueEmission[] = [];
    const service = new TableTalkService({
      level: "off",
      emit: line => emissions.push(line),
      random: () => 0,
    });
    service.handleEvent(event("large_hand_scored"), baseContext("off"));
    expect(emissions).toHaveLength(0);
  });

  it("produces fewer comments for occasional than chatty", () => {
    const occasionalEmissions: CharacterDialogueEmission[] = [];
    const chattyEmissions: CharacterDialogueEmission[] = [];
    const constantRandom = () => 0.2;

    const occasional = new TableTalkService({
      level: "occasional",
      emit: line => occasionalEmissions.push(line),
      random: constantRandom,
      cooldownMs: { occasional: 0, chatty: 0 },
    });
    const chatty = new TableTalkService({
      level: "chatty",
      emit: line => chattyEmissions.push(line),
      random: constantRandom,
      cooldownMs: { occasional: 0, chatty: 0 },
    });

    for (let i = 0; i < 20; i++) {
      occasional.handleEvent(event("game_started"), baseContext("occasional"));
      chatty.handleEvent(event("game_started"), baseContext("chatty"));
    }

    expect(occasionalEmissions.length).toBeLessThan(chattyEmissions.length);
  });

  it("cooldown prevents excessive comments but never suppresses Go or My crib", () => {
    const emissions: CharacterDialogueEmission[] = [];
    let now = 1_000;
    const service = new TableTalkService({
      level: "chatty",
      emit: line => emissions.push(line),
      random: () => 0,
      now: () => now,
      cooldownMs: { occasional: 8_000, chatty: 5_000 },
    });

    service.handleEvent(event("game_started"), baseContext("chatty"));
    service.handleEvent(event("go_declared"), baseContext("chatty"));
    service.handleEvent(event("first_crib_won"), baseContext("chatty"));
    expect(emissions).toHaveLength(3);
    expect(emissions[2].text).toBe("My crib.");

    now += 100;
    service.handleEvent(event("first_crib_won"), baseContext("chatty"));
    expect(emissions).toHaveLength(4);
    expect(emissions[3].text).toBe("My crib.");

    now += 100;
    service.handleEvent(event("go_declared"), baseContext("chatty"));
    expect(emissions).toHaveLength(5);
    expect(emissions[4].text).toBe("Go.");
  });

  it("does not immediately repeat recent lines", () => {
    const emissions: CharacterDialogueEmission[] = [];
    let now = 1;
    const service = new TableTalkService({
      level: "chatty",
      emit: line => emissions.push(line),
      random: () => 0,
      now: () => now++,
      cooldownMs: { occasional: 0, chatty: 0 },
    });

    service.handleEvent(event("game_started"), baseContext("chatty"));
    service.handleEvent(event("game_started"), baseContext("chatty"));

    expect(emissions).toHaveLength(2);
    expect(emissions[0].text).not.toBe(emissions[1].text);
  });

  it("allows only eligible computer characters to respond", () => {
    const emissions: CharacterDialogueEmission[] = [];
    const service = new TableTalkService({
      level: "chatty",
      emit: line => emissions.push(line),
      random: () => 0,
      cooldownMs: { occasional: 0, chatty: 0 },
    });
    const context = {
      ...baseContext("chatty"),
      participants: [{ playerIndex: 1, team: 1, name: "Mabel", color: "blue", characterId: "mabel" as const }],
    };
    service.handleEvent({ type: "large_hand_scored", actorIndex: 0, points: 9 }, context);
    expect(emissions).toHaveLength(1);
    expect(emissions[0].characterName).toBe("Mabel");
  });

  it("allows significant moments to bypass ordinary frequency", () => {
    const emissions: CharacterDialogueEmission[] = [];
    const service = new TableTalkService({
      level: "occasional",
      emit: line => emissions.push(line),
      random: () => 0.5,
      cooldownMs: { occasional: 0, chatty: 0 },
    });
    service.handleEvent(event("large_hand_scored"), baseContext("occasional"));
    expect(emissions).toHaveLength(1);
    expect(emissions[0].text).toBeTruthy();
    expect(emissions[0].event).toEqual(event("large_hand_scored"));
  });

  it("keeps mechanical dialogue static", () => {
    const emissions: CharacterDialogueEmission[] = [];
    const service = new TableTalkService({
      level: "chatty",
      emit: line => emissions.push(line),
      random: () => 0,
      cooldownMs: { occasional: 0, chatty: 0 },
    });

    service.handleEvent(event("go_declared"), baseContext("chatty"));

    expect(emissions[0].text).toBe("Go.");
  });

  it("lets the crib owner announce first crib possession", () => {
    const emissions: CharacterDialogueEmission[] = [];
    const service = new TableTalkService({
      level: "chatty",
      emit: line => emissions.push(line),
      random: () => 0,
      cooldownMs: { occasional: 0, chatty: 0 },
    });

    service.handleEvent(event("first_crib_won"), baseContext("chatty"));

    expect(emissions).toHaveLength(1);
    expect(emissions[0].characterName).toBe("Mabel");
    expect(emissions[0].text).toBe("My crib.");
  });

  it("does not let an AI claim first crib when the human won it", () => {
    const emissions: CharacterDialogueEmission[] = [];
    const service = new TableTalkService({
      level: "chatty",
      emit: line => emissions.push(line),
      random: () => 0,
      cooldownMs: { occasional: 0, chatty: 0 },
    });

    service.handleEvent({ type: "first_crib_won", dealerIndex: 0 }, baseContext("chatty"));

    expect(emissions).toHaveLength(0);
  });

  it("does not make an AI voice the human player's Go", () => {
    const emissions: CharacterDialogueEmission[] = [];
    const service = new TableTalkService({
      level: "chatty",
      emit: line => emissions.push(line),
      random: () => 0,
      cooldownMs: { occasional: 0, chatty: 0 },
    });

    service.handleEvent({ type: "go_declared", actorIndex: 0 }, baseContext("chatty"));

    expect(emissions).toHaveLength(0);
  });

  it("does not let a non-leading speaker claim the lead", () => {
    const emissions: CharacterDialogueEmission[] = [];
    const service = new TableTalkService({
      level: "chatty",
      emit: line => emissions.push(line),
      random: () => 0.99,
      cooldownMs: { occasional: 0, chatty: 0 },
    });

    service.handleEvent({ type: "lead_changed", newLeaderTeam: 0 }, baseContext("chatty"));

    expect(emissions).toHaveLength(1);
    expect(emissions[0].characterName).toBe("Arthur");
    expect(emissions[0].text).toBe("Your peg is setting the pace now.");
  });

  it("does not mutate the input event or context", () => {
    const emissions: CharacterDialogueEmission[] = [];
    const service = new TableTalkService({
      level: "chatty",
      emit: line => emissions.push(line),
      random: () => 0,
      cooldownMs: { occasional: 0, chatty: 0 },
    });
    const ctx = baseContext("chatty");
    const evt = event("card_played");
    const contextJson = JSON.stringify(ctx);
    const eventJson = JSON.stringify(evt);

    service.handleEvent(evt, ctx);

    expect(JSON.stringify(ctx)).toBe(contextJson);
    expect(JSON.stringify(evt)).toBe(eventJson);
    expect(emissions.length).toBeGreaterThanOrEqual(0);
  });

  it("is deterministic with the same seeded random stream", () => {
    const emissionA: CharacterDialogueEmission[] = [];
    const emissionB: CharacterDialogueEmission[] = [];
    const makeSeededRandom = () => {
      let state = 12345;
      return () => {
        state = (state * 1103515245 + 12345) % 2147483648;
        return state / 2147483648;
      };
    };

    const serviceA = new TableTalkService({
      level: "chatty",
      emit: line => emissionA.push(line),
      random: makeSeededRandom(),
      cooldownMs: { occasional: 0, chatty: 0 },
      now: (() => {
        let t = 0;
        return () => ++t;
      })(),
    });
    const serviceB = new TableTalkService({
      level: "chatty",
      emit: line => emissionB.push(line),
      random: makeSeededRandom(),
      cooldownMs: { occasional: 0, chatty: 0 },
      now: (() => {
        let t = 0;
        return () => ++t;
      })(),
    });

    const events: TableTalkEvent[] = [
      event("game_started"),
      event("go_declared"),
      event("pegging_scored"),
      event("large_hand_scored"),
      event("card_played"),
    ];
    for (const item of events) {
      serviceA.handleEvent(item, baseContext("chatty"));
      serviceB.handleEvent(item, baseContext("chatty"));
    }

    expect(emissionA.map(line => line.text)).toEqual(emissionB.map(line => line.text));
  });

  it("ignores gameplay difficulty and does not alter strategy inputs", () => {
    const baseline: CharacterDialogueEmission[] = [];
    const variant: CharacterDialogueEmission[] = [];
    const createService = (collector: CharacterDialogueEmission[]) => new TableTalkService({
      level: "chatty",
      emit: line => collector.push(line),
      random: () => 0,
      cooldownMs: { occasional: 0, chatty: 0 },
      now: (() => {
        let t = 100;
        return () => ++t;
      })(),
    });

    const serviceA = createService(baseline);
    const serviceB = createService(variant);
    const baselineContext = baseContext("chatty");
    const withDifficulty = { ...baseContext("chatty"), difficulty: "hard" } as TableTalkContext & { difficulty: string };

    serviceA.handleEvent(event("game_started"), baselineContext);
    serviceB.handleEvent(event("game_started"), withDifficulty);
    expect(baseline[0]?.text).toBe(variant[0]?.text);
  });
});
