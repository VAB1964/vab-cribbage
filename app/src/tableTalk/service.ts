import { DIALOGUE_LIBRARY, type DialogueKey } from "./dialogueLibrary";
import type {
  CharacterDialogueEmission,
  CharacterId,
  PeggingKind,
  TableTalkContext,
  TableTalkEmotion,
  TableTalkEvent,
  TableTalkLevel,
  TableTalkParticipant,
} from "./types";

type ServiceOptions = {
  level: TableTalkLevel;
  emit: (line: CharacterDialogueEmission) => void;
  now?: () => number;
  random?: () => number;
  cooldownMs?: { occasional: number; chatty: number };
  recencySize?: number;
};

type PromptChoice = {
  key: DialogueKey;
  emotion: TableTalkEmotion;
  significant: boolean;
  vars?: Record<string, number | string>;
};

const CLOSE_TO_WIN_SCORE = 110;
const WELL_BEHIND_POINTS = 18;
const CATCH_UP_POINTS = 6;

function levelProbability(level: TableTalkLevel, significance: number): number {
  if (level === "off") return 0;
  if (level === "occasional") {
    if (significance >= 3) return 0.95;
    if (significance === 2) return 0.35;
    if (significance === 1) return 0.12;
    return 0;
  }
  if (significance >= 3) return 1;
  if (significance === 2) return 0.7;
  if (significance === 1) return 0.35;
  return 0.08;
}

function scoreByTeam(context: TableTalkContext): Map<number, number> {
  const byTeam = new Map<number, number>();
  for (const score of context.scores) {
    byTeam.set(score.team, Math.max(byTeam.get(score.team) ?? 0, score.score));
  }
  return byTeam;
}

function leaderTeam(context: TableTalkContext): number | null {
  const byTeam = scoreByTeam(context);
  let bestTeam: number | null = null;
  let bestScore = -1;
  let tied = false;
  byTeam.forEach((teamScore, team) => {
    if (teamScore > bestScore) {
      bestScore = teamScore;
      bestTeam = team;
      tied = false;
      return;
    }
    if (teamScore === bestScore) tied = true;
  });
  return tied ? null : bestTeam;
}

function pointsFromDeficit(deficit: number): number {
  if (deficit >= WELL_BEHIND_POINTS) return 3;
  if (deficit >= CATCH_UP_POINTS) return 2;
  return 1;
}

export class TableTalkService {
  private level: TableTalkLevel;
  private readonly emit: (line: CharacterDialogueEmission) => void;
  private readonly now: () => number;
  private readonly random: () => number;
  private readonly cooldownMs: { occasional: number; chatty: number };
  private readonly recencySize: number;
  private lastSpokenAt = 0;
  private recentLines: string[] = [];

  constructor(options: ServiceOptions) {
    this.level = options.level;
    this.emit = options.emit;
    this.now = options.now ?? (() => Date.now());
    this.random = options.random ?? (() => Math.random());
    this.cooldownMs = options.cooldownMs ?? { occasional: 8500, chatty: 4200 };
    this.recencySize = options.recencySize ?? 14;
  }

  setLevel(level: TableTalkLevel) {
    this.level = level;
  }

  handleEvent(event: Readonly<TableTalkEvent>, context: Readonly<TableTalkContext>) {
    if (this.level === "off" || context.level === "off") return;
    if (!context.participants.length) return;

    let prompt = this.promptFor(event, context);
    if (!prompt) return;
    const forced = event.type === "go_declared" || event.type === "first_crib_won";

    const inCooldown = this.inCooldown();
    if (!forced && inCooldown && !prompt.significant) return;

    const chance = levelProbability(this.level, prompt.significant ? 3 : this.eventSignificance(event));
    if (!forced && (chance <= 0 || this.random() > chance)) return;

    const speaker = this.chooseSpeaker(event, context);
    if (!speaker) return;
    if (event.type === "lead_changed") {
      prompt = {
        key: speaker.team === event.newLeaderTeam ? "lead_changed_self" : "lead_changed_opp",
        emotion: speaker.team === event.newLeaderTeam ? "competitive" : "supportive",
        significant: true,
      };
    }

    const line = this.selectLine(speaker.characterId, prompt.key, prompt.vars);
    if (!line) return;

    if (!forced && this.recentLines.includes(line)) return;
    if (!forced) this.rememberLine(line);
    this.lastSpokenAt = this.now();

    this.emit({
      characterId: speaker.characterId,
      characterName: speaker.name,
      text: line,
      eventType: event.type,
      emotion: prompt.emotion,
      timestamp: this.now(),
      event: { ...event },
      context: {
        ...context,
        scores: context.scores.map(score => ({ ...score })),
        participants: context.participants.map(participant => ({ ...participant })),
      },
    });
  }

  private inCooldown(): boolean {
    if (!this.lastSpokenAt) return false;
    const elapsed = this.now() - this.lastSpokenAt;
    const cooldown = this.level === "chatty" ? this.cooldownMs.chatty : this.cooldownMs.occasional;
    return elapsed < cooldown;
  }

  private rememberLine(line: string) {
    this.recentLines = [line, ...this.recentLines].slice(0, this.recencySize);
  }

  private chooseSpeaker(
    event: Readonly<TableTalkEvent>,
    context: Readonly<TableTalkContext>,
  ): TableTalkParticipant | null {
    const byIndex = new Map(context.participants.map(participant => [participant.playerIndex, participant]));
    const actorIndex =
      "actorIndex" in event ? event.actorIndex :
      "ownerIndex" in event ? event.ownerIndex :
      "winnerIndex" in event ? event.winnerIndex :
      "loserIndex" in event ? event.loserIndex :
      "dealerIndex" in event ? event.dealerIndex :
      null;

    if (actorIndex !== null && actorIndex !== undefined) {
      const actor = byIndex.get(actorIndex);
      if (actor) return actor;
      if (event.type === "go_declared") return null;
      if (event.type === "first_crib_won") return null;
    }

    if (event.type === "lead_changed") {
      const leader = context.participants.find(participant => participant.team === event.newLeaderTeam);
      if (leader) return leader;
    }

    if (event.type === "game_won") {
      const winner = context.participants.find(participant => participant.team === event.winnerTeam);
      if (winner) return winner;
    }

    if (event.type === "game_lost") {
      const loser = context.participants.find(participant => participant.playerIndex === event.loserIndex);
      if (loser) return loser;
      const firstLoser = context.participants.find(participant => participant.team !== event.winnerTeam);
      if (firstLoser) return firstLoser;
    }

    const all = [...context.participants];
    return all.length ? all[Math.floor(this.random() * all.length)] : null;
  }

  private selectLine(
    characterId: CharacterId,
    key: DialogueKey,
    vars?: Record<string, number | string>,
  ): string | null {
    const pool = DIALOGUE_LIBRARY[characterId][key] ?? DIALOGUE_LIBRARY[characterId].generic_card_play;
    if (!pool || !pool.lines.length) return null;
    const lines = pool.lines.filter(line => !this.recentLines.includes(this.renderLine(line, vars)));
    const source = lines.length ? lines : pool.lines;
    const chosen = source[Math.floor(this.random() * source.length)];
    return this.renderLine(chosen, vars);
  }

  private renderLine(line: string, vars?: Record<string, number | string>) {
    if (!vars) return line;
    return Object.entries(vars).reduce(
      (text, [key, value]) => text.replaceAll(`{${key}}`, String(value)),
      line,
    );
  }

  private eventSignificance(event: Readonly<TableTalkEvent>): number {
    switch (event.type) {
      case "game_won":
      case "game_lost":
      case "large_hand_scored":
      case "large_crib_scored":
      case "zero_point_hand":
      case "player_close_to_winning":
      case "opponent_close_to_winning":
      case "lead_changed":
      case "computer_falls_well_behind":
      case "computer_catches_up":
        return 3;
      case "pegging_scored":
        if (event.kind === "double_pair_royal" || event.kind === "pair_royal" || event.kind === "pegging_run") return 3;
        if (event.kind === "thirty_one" || event.kind === "fifteen" || event.kind === "pair") return 2;
        return 1;
      case "go_declared":
      case "last_card_scored":
      case "hand_revealed":
      case "crib_revealed":
      case "round_started":
      case "first_crib_won":
        return 1;
      case "card_played":
        return 0;
      case "game_started":
        return 1;
      default:
        return 1;
    }
  }

  private promptFor(
    event: Readonly<TableTalkEvent>,
    context: Readonly<TableTalkContext>,
  ): PromptChoice | null {
    if (event.type === "game_started") return { key: "game_started", emotion: "supportive", significant: false };
    if (event.type === "round_started") return { key: "round_started", emotion: "playful", significant: false };
    if (event.type === "card_played") return { key: "generic_card_play", emotion: "playful", significant: false };
    if (event.type === "go_declared") return { key: "go_declared", emotion: "concerned", significant: false };
    if (event.type === "first_crib_won") return { key: "first_crib_won", emotion: "playful", significant: false };

    if (event.type === "pegging_scored") {
      const actorIsComputer = context.participants.some(participant => participant.playerIndex === event.actorIndex);
      const kindKey = this.peggingKey(event.kind, actorIsComputer);
      return { key: kindKey, emotion: "competitive", significant: event.points >= 3, vars: { points: event.points } };
    }

    if (event.type === "last_card_scored") {
      const actorIsComputer = context.participants.some(participant => participant.playerIndex === event.actorIndex);
      return { key: actorIsComputer ? "self_last_card" : "opp_last_card", emotion: "competitive", significant: false };
    }

    if (event.type === "hand_revealed") {
      const actorIsComputer = context.participants.some(participant => participant.playerIndex === event.actorIndex);
      if (event.points <= 0) return { key: actorIsComputer ? "self_zero_hand" : "opp_zero_hand", emotion: "concerned", significant: true };
      if (event.points >= 8) return { key: actorIsComputer ? "self_large_hand" : "opp_large_hand", emotion: "competitive", significant: true, vars: { points: event.points } };
      return null;
    }

    if (event.type === "large_hand_scored") {
      const actorIsComputer = context.participants.some(participant => participant.playerIndex === event.actorIndex);
      return {
        key: actorIsComputer ? "self_large_hand" : "opp_large_hand",
        emotion: "competitive",
        significant: true,
        vars: { points: event.points },
      };
    }

    if (event.type === "zero_point_hand") {
      const actorIsComputer = context.participants.some(participant => participant.playerIndex === event.actorIndex);
      return { key: actorIsComputer ? "self_zero_hand" : "opp_zero_hand", emotion: "concerned", significant: true };
    }

    if (event.type === "crib_revealed") return null;

    if (event.type === "large_crib_scored") {
      const ownerIsComputer = context.participants.some(participant => participant.playerIndex === event.ownerIndex);
      return {
        key: ownerIsComputer ? "self_large_crib" : "opp_large_crib",
        emotion: "competitive",
        significant: true,
        vars: { points: event.points },
      };
    }

    if (event.type === "lead_changed") {
      return { key: "lead_changed_self", emotion: "competitive", significant: true };
    }

    if (event.type === "player_close_to_winning") {
      return {
        key: "close_to_winning_self",
        emotion: "competitive",
        significant: event.score >= CLOSE_TO_WIN_SCORE,
      };
    }

    if (event.type === "opponent_close_to_winning") {
      return {
        key: "opponent_close_to_winning",
        emotion: "concerned",
        significant: event.score >= CLOSE_TO_WIN_SCORE,
      };
    }

    if (event.type === "computer_falls_well_behind") {
      return {
        key: "falls_behind",
        emotion: "concerned",
        significant: pointsFromDeficit(event.deficit) >= 2,
      };
    }

    if (event.type === "computer_catches_up") {
      return {
        key: "catches_up",
        emotion: "optimistic",
        significant: pointsFromDeficit(event.deficit) >= 1,
      };
    }

    if (event.type === "game_won") {
      return { key: "game_won", emotion: "competitive", significant: true };
    }

    if (event.type === "game_lost") {
      return { key: "game_lost", emotion: "supportive", significant: true };
    }

    return null;
  }

  private peggingKey(kind: PeggingKind, self: boolean): DialogueKey {
    if (kind === "fifteen") return self ? "self_fifteen" : "opp_fifteen";
    if (kind === "thirty_one") return self ? "self_thirty_one" : "opp_thirty_one";
    if (kind === "pair") return self ? "self_pair" : "opp_pair";
    if (kind === "pair_royal") return self ? "self_pair_royal" : "opp_pair_royal";
    if (kind === "double_pair_royal") return self ? "self_double_pair_royal" : "opp_double_pair_royal";
    return self ? "self_pegging_run" : "opp_pegging_run";
  }
}
