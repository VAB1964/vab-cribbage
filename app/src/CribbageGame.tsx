"use client";

import { useEffect, useMemo, useRef, useState, type CSSProperties } from "react";
import { buildTableTalkContext, toPublicCard } from "./tableTalk/context";
import { TableTalkService } from "./tableTalk/service";
import {
  loadTableTalkLevel,
  loadTableTalkVoiceEnabled,
  saveTableTalkLevel,
  saveTableTalkVoiceEnabled,
} from "./tableTalk/storage";
import type {
  CharacterDialogueEmission,
  PeggingKind,
  TableTalkContext,
  TableTalkEvent,
  TableTalkLevel,
} from "./tableTalk/types";
import { CloudTableTalkVoiceOutput } from "./tableTalk/cloudVoiceOutput";
import type { PlayerPreferences } from "./identity/preferences";

type Suit = "♠" | "♥" | "♦" | "♣";
type Card = { rank: number; suit: Suit; id: string };
type Player = { name: string; color: string; hand: Card[]; score: number; team: number };
type Phase = "menu" | "cutting" | "discard" | "pegging" | "counting" | "gameover";
type Difficulty = "easy" | "medium" | "hard";
type ScoreEvent = { label: string; points: number; cards: Card[] };
type HandCount = { label: string; color: string; kind: "hand" | "crib"; cards: Card[]; cut: Card; result: ReturnType<typeof scoreCards> };
type OpeningDraw = { player: number; card: Card; round: number };
type HistoryEntry =
  | { kind: "game"; text: string }
  | { kind: "dialogue"; characterName: string; characterColor: string; text: string; scripted: boolean; category: TableTalkEvent["type"] };
type TableTalkPlayback = {
  line: CharacterDialogueEmission;
  phase: "intro" | "loading" | "speaking" | "reading";
};
type CardPlayAnimation = {
  card: Card;
  playerIndex: number;
  faceDown: boolean;
  left: number;
  top: number;
  width: number;
  height: number;
  dx: number;
  dy: number;
};

const SUITS: Suit[] = ["♠", "♥", "♦", "♣"];
const COLORS = ["red", "blue", "green", "purple"];
const NAMES = ["You", "Mabel", "Arthur", "Clara"];
const RANK = (n: number) => n === 1 ? "A" : n === 11 ? "J" : n === 12 ? "Q" : n === 13 ? "K" : String(n);
const SUIT_NAME: Record<Suit, string> = { "♠": "spades", "♥": "hearts", "♦": "diamonds", "♣": "clubs" };
const value = (c: Card) => Math.min(c.rank, 10);

function combinations<T>(items: T[], count: number): T[][] {
  if (count === 0) return [[]];
  if (items.length < count) return [];
  return items.flatMap((item, index) => combinations(items.slice(index + 1), count - 1).map(rest => [item, ...rest]));
}

function cribCardValue(card: Card) {
  return card.rank === 5 ? 5.5 : value(card) === 10 ? 1.2 : card.rank === 1 ? 1 : .35;
}

function discardSynergy(cards: Card[]) {
  let score = cards.reduce((sum, card) => sum + cribCardValue(card), 0);
  if (cards.length === 2) {
    if (cards[0].rank === cards[1].rank) score += 3;
    if (value(cards[0]) + value(cards[1]) === 15) score += 4;
    if (cards[0].suit === cards[1].suit) score += .6;
    const gap = Math.abs(cards[0].rank - cards[1].rank);
    if (gap === 1) score += 1.4;
    if (gap === 2) score += .8;
  }
  return score;
}

function deck(): Card[] {
  return SUITS.flatMap(suit => Array.from({ length: 13 }, (_, i) => ({ rank: i + 1, suit, id: `${suit}-${i + 1}` })))
    .sort(() => Math.random() - .5);
}

function peggingEvents(next: Card, currentPile: Card[], total: number): { kind: PeggingKind; points: number }[] {
  const cards = [...currentPile, next];
  const nextTotal = total + value(next);
  const events: { kind: PeggingKind; points: number }[] = [];
  if (nextTotal === 15) events.push({ kind: "fifteen", points: 2 });
  if (nextTotal === 31) events.push({ kind: "thirty_one", points: 2 });

  let same = 1;
  for (let i = cards.length - 2; i >= 0 && cards[i].rank === next.rank; i--) same++;
  if (same === 2) events.push({ kind: "pair", points: 2 });
  if (same === 3) events.push({ kind: "pair_royal", points: 6 });
  if (same === 4) events.push({ kind: "double_pair_royal", points: 12 });

  for (let len = Math.min(cards.length, 7); len >= 3; len--) {
    const ranks = cards.slice(-len).map(card => card.rank).sort((a, b) => a - b);
    if (new Set(ranks).size === len && ranks[len - 1] - ranks[0] === len - 1) {
      events.push({ kind: "pegging_run", points: len });
      break;
    }
  }
  return events;
}

function scoreCards(cards: Card[], cut?: Card, isCrib = false) {
  const all = cut ? [...cards, cut] : cards;
  let fifteens = 0, pairs = 0, runs = 0, flush = 0, nobs = 0;
  const events: ScoreEvent[] = [];
  for (let mask = 1; mask < (1 << all.length); mask++) {
    const chosen = all.filter((_, i) => mask & (1 << i));
    if (chosen.reduce((s, c) => s + value(c), 0) === 15) {
      fifteens += 2;
      events.push({ label: "Fifteen", points: 2, cards: chosen });
    }
  }
  for (let i = 0; i < all.length; i++) for (let j = i + 1; j < all.length; j++) if (all[i].rank === all[j].rank) {
    pairs += 2;
    events.push({ label: "Pair", points: 2, cards: [all[i], all[j]] });
  }
  const counts = Array(14).fill(0); all.forEach(c => counts[c.rank]++);
  for (let len = 5; len >= 3 && !runs; len--) {
    const runEvents: ScoreEvent[] = [];
    for (let mask = 1; mask < (1 << all.length); mask++) {
      const chosen = all.filter((_, i) => mask & (1 << i));
      if (chosen.length !== len) continue;
      const ranks = chosen.map(c => c.rank).sort((a, b) => a - b);
      if (new Set(ranks).size === len && ranks[len - 1] - ranks[0] === len - 1) runEvents.push({ label: `Run of ${len}`, points: len, cards: chosen });
    }
    if (runEvents.length) {
      runs = runEvents.reduce((sum, event) => sum + event.points, 0);
      events.push(...runEvents);
    }
  }
  if (cut && cards.every(c => c.suit === cards[0].suit)) {
    if (cut.suit === cards[0].suit) { flush = 5; events.push({ label: "Five-card flush", points: 5, cards: all }); }
    else if (!isCrib) { flush = 4; events.push({ label: "Four-card flush", points: 4, cards }); }
  }
  const nob = cut && cards.find(c => c.rank === 11 && c.suit === cut.suit);
  if (cut && nob) { nobs = 1; events.push({ label: "His nobs", points: 1, cards: [nob, cut] }); }
  return { fifteens, pairs, runs, flush, nobs, total: fifteens + pairs + runs + flush + nobs, events };
}

function CountCard({ card, tableCard = false }: { card: Card; tableCard?: boolean }) {
  const warm = card.suit === "♥" || card.suit === "♦";
  return <span className={`count-card ${warm ? "warm" : ""} ${tableCard ? "table-card" : ""}`} title={tableCard ? "Table card" : undefined}>{RANK(card.rank)}{card.suit}</span>;
}

function CardView({ card, selected, hidden, onClick, small, playSource, animating }: { card: Card; selected?: boolean; hidden?: boolean; onClick?: () => void; small?: boolean; playSource?: string; animating?: boolean }) {
  const warm = !hidden && (card.suit === "♥" || card.suit === "♦");
  return <button data-play-source={playSource} className={`card ${hidden ? "back" : ""} ${warm ? "warm" : ""} ${selected ? "selected" : ""} ${small ? "small" : ""} ${animating ? "playing" : ""}`} onClick={onClick} disabled={!onClick} aria-label={hidden ? "Face-down card" : `${RANK(card.rank)} of ${SUIT_NAME[card.suit]}`}>
    {!hidden && <><span>{RANK(card.rank)}</span><b>{card.suit}</b><em>{card.suit}</em></>}
  </button>;
}

function AnimatedScore({ score }: { score: number }) {
  const [displayedScore, setDisplayedScore] = useState(score);
  const [gain, setGain] = useState(0);
  useEffect(() => {
    if (score === displayedScore) return;
    if (score < displayedScore) {
      setDisplayedScore(score);
      setGain(0);
      return;
    }
    setGain(score - displayedScore);
    const updateTimer = window.setTimeout(() => setDisplayedScore(score), 450);
    const clearTimer = window.setTimeout(() => setGain(0), 1800);
    return () => {
      window.clearTimeout(updateTimer);
      window.clearTimeout(clearTimer);
    };
  }, [score]);
  return <div className="player-score"><strong>{displayedScore}</strong>{gain > 0 && <span key={`${displayedScore}-${score}`}>+{gain}</span>}</div>;
}

function Board({ players, playerCount }: { players: Player[]; playerCount: number }) {
  const laneInfo = [
    { name: playerCount === 4 ? "You + Arthur" : "You", score: players[0]?.score ?? 0, color: "red" },
    { name: playerCount === 4 ? "Mabel + Clara" : "Mabel", score: players[1]?.score ?? 0, color: "blue" },
    { name: playerCount >= 3 && playerCount !== 4 ? "Arthur" : "Open lane", score: playerCount === 3 ? players[2]?.score ?? 0 : 0, color: "green" },
  ].slice(0, playerCount === 4 ? 2 : playerCount);
  const scores = laneInfo.map(lane => lane.score);
  const previousScoresRef = useRef(scores);
  const [scoreMoves, setScoreMoves] = useState<Record<number, { from: number; to: number; amount: number }>>({});
  useEffect(() => {
    const moves: Record<number, { from: number; to: number; amount: number }> = {};
    scores.forEach((score, index) => {
      const previous = previousScoresRef.current[index] ?? 0;
      if (score > previous) moves[index] = { from: previous, to: score, amount: score - previous };
    });
    previousScoresRef.current = scores;
    if (!Object.keys(moves).length) return;
    setScoreMoves(moves);
    const timer = window.setTimeout(() => setScoreMoves({}), 2000);
    return () => window.clearTimeout(timer);
  }, [scores[0], scores[1], scores[2]]);
  return <section className="board" aria-label={`${laneInfo.length} lane cribbage board`}>
    <div className="board-title"><span>♣</span><h1>Cribbage</h1><span>♣</span></div>
    {laneInfo.map((lane, idx) => {
      const active = idx < (playerCount === 4 ? 2 : playerCount);
      const move = scoreMoves[idx];
      return <div className={`lane ${lane.color} ${active ? "" : "inactive"}`} key={lane.color}>
        <div className="lane-name"><span className="color-dot" />{lane.name}<strong>{active ? lane.score : "—"}</strong></div>
        <div className="track">
          {Array.from({ length: 121 }, (_, i) => {
            const point = i + 1;
            const marker = active && Math.min(121, lane.score) === point;
            const alreadyPegged = active && point < Math.min(121, lane.score);
            const inTrail = !!move && move.amount > 1 && point > move.from && point <= move.to;
            const ghost = !!move && move.amount > 1 && move.from > 0 && point === move.from;
            return <i key={point} className={`${point % 5 === 0 ? "fifth" : ""} ${point === 61 || point === 91 ? "skunk-line" : ""} ${alreadyPegged ? "already-pegged" : ""} ${marker ? "has-peg" : ""} ${inTrail ? "score-trail" : ""} ${ghost ? "has-ghost" : ""}`} title={`${point} points${alreadyPegged ? " — already pegged" : ""}`}><span />{marker && move?.amount > 1 && <b className="score-jump">+{move.amount}</b>}</i>;
          })}
        </div>
        <div className="milestones"><span>0</span><span>30</span><span>60</span><span>90</span><span>121</span></div>
      </div>;
    })}
  </section>;
}

export default function Home({ initialPreferences, onExit }: { initialPreferences?: PlayerPreferences; onExit?: () => void }) {
  const [phase, setPhase] = useState<Phase>("menu");
  const [playerCount, setPlayerCount] = useState(3);
  const [difficulty, setDifficulty] = useState<Difficulty>("medium");
  const [tableTalkLevel, setTableTalkLevel] = useState<TableTalkLevel>(() => initialPreferences?.tableTalk ?? loadTableTalkLevel("occasional"));
  const [tableTalkVoiceEnabled, setTableTalkVoiceEnabled] = useState(() => initialPreferences?.voiceEnabled ?? loadTableTalkVoiceEnabled(false));
  const [players, setPlayers] = useState<Player[]>([]);
  const [scoringHands, setScoringHands] = useState<Card[][]>([]);
  const [dealer, setDealer] = useState(1);
  const [crib, setCrib] = useState<Card[]>([]);
  const [cut, setCut] = useState<Card | null>(null);
  const [selected, setSelected] = useState<string[]>([]);
  const [pile, setPile] = useState<Card[]>([]);
  const [running, setRunning] = useState(0);
  const [turn, setTurn] = useState(0);
  const [lastPegger, setLastPegger] = useState<number | null>(null);
  const [messageHistory, setMessageHistory] = useState<HistoryEntry[]>([
    { kind: "game", text: "Choose the number of players, then start a game." },
  ]);
  const [tableTalkPlayback, setTableTalkPlayback] = useState<TableTalkPlayback | null>(null);
  const [nextTableTalkSpeaker, setNextTableTalkSpeaker] = useState<string | null>(null);
  const [tableTalkBlocking, setTableTalkBlocking] = useState(false);
  const [peggingHold, setPeggingHold] = useState(false);
  const [cardPlayAnimation, setCardPlayAnimation] = useState<CardPlayAnimation | null>(null);
  const [breakdown, setBreakdown] = useState<ReturnType<typeof scoreCards> | null>(null);
  const [handCounts, setHandCounts] = useState<HandCount[]>([]);
  const [winner, setWinner] = useState("");
  const [openingDraws, setOpeningDraws] = useState<OpeningDraw[]>([]);
  const [muted, setMuted] = useState(initialPreferences ? !initialPreferences.soundEnabled : false);
  const [volume, setVolume] = useState(initialPreferences?.volume ?? .55);
  const [turnReminder, setTurnReminder] = useState(false);
  const deckRef = useRef<Card[]>([]);
  const messageWindowRef = useRef<HTMLDivElement>(null);
  const peggingTargetRef = useRef<HTMLDivElement>(null);
  const messageHistoryRef = useRef<HistoryEntry[]>(messageHistory);
  const shouldAutoScrollRef = useRef(true);
  const audioRef = useRef<AudioContext | null>(null);
  const mutedRef = useRef(muted);
  const volumeRef = useRef(volume);
  const playersRef = useRef<Player[]>(players);
  const tableTalkVoiceEnabledRef = useRef(tableTalkVoiceEnabled);
  const pendingScoreByTeamRef = useRef<Record<number, number>>({});
  const scoreRaceStateRef = useRef<Record<number, { behind: boolean }>>({});
  const goPlayersRef = useRef(new Set<number>());
  const pendingGoResolutionRef = useRef<{ declarer: number; lastPegger: number | null } | null>(null);
  const cardPlayAnimatingRef = useRef(false);
  const cardPlayTimerRef = useRef<number | null>(null);
  const cloudTableTalkVoiceRef = useRef<CloudTableTalkVoiceOutput | null>(null);
  const tableTalkQueueRef = useRef<CharacterDialogueEmission[]>([]);
  const tableTalkSpeakersInSequenceRef = useRef(new Set<CharacterDialogueEmission["characterId"]>());
  const tableTalkPlayingRef = useRef(false);
  const continueTableTalkRef = useRef<(() => void) | null>(null);
  const tableTalkSkippedRef = useRef(false);
  if (!cloudTableTalkVoiceRef.current) {
    cloudTableTalkVoiceRef.current = new CloudTableTalkVoiceOutput({
      enabled: tableTalkVoiceEnabled && !muted,
      onError: (message) => {
        announce(`Prerecorded voice unavailable: ${message}`);
      },
    });
  }

  function waitForTableTalk(ms: number) {
    return new Promise<void>(resolve => window.setTimeout(resolve, ms));
  }
  function continueTableTalk() {
    if (!continueTableTalkRef.current) return;
    tableTalkSkippedRef.current = true;
    cloudTableTalkVoiceRef.current?.cancel();
    continueTableTalkRef.current();
  }
  async function playNextTableTalk() {
    if (tableTalkPlayingRef.current) return;
    const queuedLine = tableTalkQueueRef.current.shift();
    if (!queuedLine) {
      tableTalkSpeakersInSequenceRef.current.clear();
      setNextTableTalkSpeaker(null);
      setTableTalkBlocking(false);
      return;
    }
    tableTalkPlayingRef.current = true;
    tableTalkSkippedRef.current = false;
    setTableTalkBlocking(true);
    setNextTableTalkSpeaker(tableTalkQueueRef.current[0]?.characterName ?? null);
    const line = queuedLine;
    setTableTalkPlayback({ line, phase: "intro" });
    if (line.eventType !== "go_declared") await waitForTableTalk(350);
    const continued = new Promise<void>(resolve => {
      continueTableTalkRef.current = resolve;
    });
    setTableTalkPlayback({ line, phase: "loading" });
    const showSpeaking = () => setTableTalkPlayback({ line, phase: "speaking" });
    const voiceEnabled = tableTalkVoiceEnabledRef.current && !mutedRef.current;
    const didSpeak = voiceEnabled
      ? (await cloudTableTalkVoiceRef.current?.speak(line, showSpeaking)) ?? false
      : false;
    if (voiceEnabled && !didSpeak) {
      continueTableTalkRef.current = null;
      setTableTalkPlayback(null);
      tableTalkPlayingRef.current = false;
      void playNextTableTalk();
      return;
    }
    appendDialogueHistory(line);
    if (!tableTalkSkippedRef.current) {
      setTableTalkPlayback({ line, phase: "reading" });
      const readingDelayMs = line.eventType === "go_declared" ? 0 : didSpeak ? 0 : 1800;
      await Promise.race([waitForTableTalk(readingDelayMs), continued]);
    }
    continueTableTalkRef.current?.();
    continueTableTalkRef.current = null;
    setTableTalkPlayback(null);
    tableTalkPlayingRef.current = false;
    void playNextTableTalk();
  }
  function enqueueTableTalk(line: CharacterDialogueEmission) {
    if (tableTalkSpeakersInSequenceRef.current.has(line.characterId)) return;
    tableTalkSpeakersInSequenceRef.current.add(line.characterId);
    tableTalkQueueRef.current.push(line);
    if (tableTalkPlayingRef.current) {
      setNextTableTalkSpeaker(tableTalkQueueRef.current[0]?.characterName ?? null);
    }
    void playNextTableTalk();
  }
  function appendDialogueHistory(line: CharacterDialogueEmission) {
    const speaker = playersRef.current.find(player => player.name === line.characterName);
    setMessageHistory(old => [
      ...old,
      {
        kind: "dialogue",
        characterName: line.characterName,
        characterColor: speaker?.color ?? "blue",
        text: line.text,
        scripted: true,
        category: line.eventType,
      },
    ]);
  }

  const tableTalkRef = useRef<TableTalkService | null>(null);
  if (!tableTalkRef.current) {
    tableTalkRef.current = new TableTalkService({
      level: tableTalkLevel,
      emit: (line: CharacterDialogueEmission) => {
        enqueueTableTalk(line);
      },
    });
  }

  const needDiscard = playerCount === 2 ? 2 : playerCount === 3 ? 1 : 1;
  const handSize = playerCount === 2 ? 6 : 5;
  function asHistoryText(entry: HistoryEntry) {
    return entry.kind === "game" ? entry.text : `${entry.characterName}: "${entry.text}"`;
  }
  function formatDialogueText(text: string, _scripted: boolean, category: TableTalkEvent["type"]) {
    return `${text} (scripted • ${category})`;
  }
  function announce(text: string) {
    setMessageHistory(old => [...old, { kind: "game", text }]);
  }
  function tableTalkContext(overrideScores?: Player[]): TableTalkContext {
    return buildTableTalkContext({
      level: tableTalkLevel,
      players: (overrideScores ?? players).map(player => ({ name: player.name, color: player.color, score: player.score, team: player.team })),
      playerCount,
      dealerIndex: dealer,
      runningCount: running,
    });
  }
  function publishTableTalk(event: TableTalkEvent, overrideScores?: Player[]) {
    tableTalkRef.current?.handleEvent(event, tableTalkContext(overrideScores));
  }
  function shouldPublishFocusCommentaryForActor(actorIndex: number) {
    const focusHumanThisLine = Math.random() < 0.5;
    const actorIsHuman = actorIndex === 0;
    return focusHumanThisLine === actorIsHuman;
  }
  function shouldPublishFocusCommentaryForOwner(ownerIndex: number) {
    const focusHumanThisLine = Math.random() < 0.5;
    const ownerIsHuman = ownerIndex === 0;
    return focusHumanThisLine === ownerIsHuman;
  }
  function onHistoryScroll() {
    const window = messageWindowRef.current;
    if (!window) return;
    const distanceToBottom = window.scrollHeight - window.scrollTop - window.clientHeight;
    shouldAutoScrollRef.current = distanceToBottom < 24;
  }
  function audioContext() {
    const AudioCtx = window.AudioContext || (window as unknown as { webkitAudioContext: typeof AudioContext }).webkitAudioContext;
    if (!AudioCtx) return null;
    if (!audioRef.current) audioRef.current = new AudioCtx();
    if (audioRef.current.state === "suspended") void audioRef.current.resume();
    return audioRef.current;
  }
  function tone(frequency: number, duration: number, delay = 0, type: OscillatorType = "sine", level = .13) {
    if (mutedRef.current) return;
    const ctx = audioContext(); if (!ctx) return;
    const osc = ctx.createOscillator(), gain = ctx.createGain();
    const start = ctx.currentTime + delay;
    osc.type = type; osc.frequency.setValueAtTime(frequency, start);
    gain.gain.setValueAtTime(.0001, start);
    gain.gain.exponentialRampToValueAtTime(Math.max(.0001, level * volumeRef.current), start + .008);
    gain.gain.exponentialRampToValueAtTime(.0001, start + duration);
    osc.connect(gain).connect(ctx.destination); osc.start(start); osc.stop(start + duration + .02);
  }
  function noise(duration = .08, delay = 0, level = .045) {
    if (mutedRef.current) return;
    const ctx = audioContext(); if (!ctx) return;
    const length = Math.max(1, Math.floor(ctx.sampleRate * duration));
    const buffer = ctx.createBuffer(1, length, ctx.sampleRate), data = buffer.getChannelData(0);
    for (let i = 0; i < length; i++) data[i] = (Math.random() * 2 - 1) * (1 - i / length);
    const source = ctx.createBufferSource(), filter = ctx.createBiquadFilter(), gain = ctx.createGain();
    source.buffer = buffer; filter.type = "bandpass"; filter.frequency.value = 1250;
    gain.gain.value = level * volumeRef.current;
    source.connect(filter).connect(gain).connect(ctx.destination); source.start(ctx.currentTime + delay);
  }
  function sound(kind: "click" | "deal" | "slide" | "card" | "go" | "count" | "win") {
    if (kind === "click") tone(520, .045, 0, "triangle", .07);
    if (kind === "deal") { [0,1,2,3].forEach(i => noise(.055, i * .045, .05)); tone(190, .12, .17, "triangle", .035); }
    if (kind === "slide") { noise(.14, 0, .055); tone(230, .09, .06, "triangle", .04); }
    if (kind === "card") { noise(.065, 0, .075); tone(150, .07, 0, "triangle", .05); }
    if (kind === "go") { tone(280, .1, 0, "triangle", .08); tone(220, .14, .09, "triangle", .07); }
    if (kind === "count") { tone(523, .11, 0, "sine", .08); tone(659, .14, .09, "sine", .09); }
    if (kind === "win") [523,659,784,1047].forEach((f,i) => tone(f, .28, i * .12, "triangle", .13));
  }
  function chime(player: number, steps = 1) {
    if (mutedRef.current) return;
    const ctx = audioContext(); if (!ctx) return;
    const base = [330, 440, 550][players[player]?.team ?? player % 3];
    for (let i = 0; i < Math.min(steps, 8); i++) {
      const osc = ctx.createOscillator(), gain = ctx.createGain();
      osc.type = "sine"; osc.frequency.value = base * Math.pow(2, i / 12);
      gain.gain.setValueAtTime(.0001, ctx.currentTime + i * .08); gain.gain.exponentialRampToValueAtTime(.11 * volumeRef.current, ctx.currentTime + i * .08 + .01); gain.gain.exponentialRampToValueAtTime(.0001, ctx.currentTime + i * .08 + .18);
      osc.connect(gain).connect(ctx.destination); osc.start(ctx.currentTime + i * .08); osc.stop(ctx.currentTime + i * .08 + .2);
    }
  }

  function teamLeaderFrom(playersView: Player[]) {
    const teamScores = new Map<number, number>();
    playersView.slice(0, playerCount).forEach(player => {
      teamScores.set(player.team, Math.max(teamScores.get(player.team) ?? 0, player.score));
    });
    let bestTeam: number | null = null;
    let bestScore = -1;
    let tied = false;
    teamScores.forEach((score, team) => {
      if (score > bestScore) {
        bestScore = score;
        bestTeam = team;
        tied = false;
        return;
      }
      if (score === bestScore) tied = true;
    });
    return tied ? null : bestTeam;
  }

  function scoreForIndex(playersView: Player[], index: number) {
    return playersView[index]?.score ?? 0;
  }

  function addScore(
    index: number,
    amount: number,
    reason: string,
    options?: { suppressLeadChangedTalk?: boolean },
  ) {
    if (!amount) return false;
    const beforeLeader = teamLeaderFrom(players);
    const team = players[index].team;
    const pending = pendingScoreByTeamRef.current[team] ?? 0;
    const baseScore = (players.find(p => p.team === team)?.score ?? 0) + pending;
    const final = Math.min(121, baseScore + amount);
    pendingScoreByTeamRef.current[team] = pending + (final - baseScore);
    const projectedPlayers = players.map(player => (
      player.team !== team
        ? player
        : { ...player, score: Math.min(121, player.score + amount) }
    ));
    setPlayers(old => old.map((p, i) => {
      if (p.team !== team) return p;
      return { ...p, score: Math.min(121, p.score + amount) };
    }));
    chime(index, amount);
    const pegVerb = players[index].name === "You" ? "peg" : "pegs";
    announce(`${players[index].name} ${pegVerb} ${amount} for ${reason}. New score: ${final}.`);

    if (reason === "31" && shouldPublishFocusCommentaryForActor(index)) publishTableTalk({ type: "pegging_scored", actorIndex: index, points: amount, kind: "thirty_one", runningTotal: 31 }, projectedPlayers);
    if (reason === "last card" && shouldPublishFocusCommentaryForActor(index)) publishTableTalk({ type: "last_card_scored", actorIndex: index, points: 1 }, projectedPlayers);

    const suppressLeadChangedTalk = options?.suppressLeadChangedTalk ?? (phase === "pegging" || phase === "counting");
    const afterLeader = teamLeaderFrom(projectedPlayers);
    if (!suppressLeadChangedTalk && afterLeader !== null && beforeLeader !== afterLeader) {
      publishTableTalk({ type: "lead_changed", newLeaderTeam: afterLeader }, projectedPlayers);
    }

    const closeToWinThreshold = 110;
    projectedPlayers.slice(0, playerCount).forEach((player, playerIndex) => {
      const previous = scoreForIndex(players, playerIndex);
      const now = player.score;
      if (previous < closeToWinThreshold && now >= closeToWinThreshold) {
        if (playerIndex === 0) publishTableTalk({ type: "opponent_close_to_winning", actorIndex: playerIndex, score: now }, projectedPlayers);
        else publishTableTalk({ type: "player_close_to_winning", actorIndex: playerIndex, score: now }, projectedPlayers);
      }
    });

    const topScore = Math.max(...projectedPlayers.slice(0, playerCount).map(player => player.score));
    projectedPlayers.slice(1, playerCount).forEach((player, playerIndexOffset) => {
      const playerIndex = playerIndexOffset + 1;
      const deficit = topScore - player.score;
      const beforeDeficit = topScore - scoreForIndex(players, playerIndex);
      const wasBehind = scoreRaceStateRef.current[playerIndex]?.behind ?? beforeDeficit >= 18;
      const isBehind = deficit >= 18;
      if (!wasBehind && isBehind) publishTableTalk({ type: "computer_falls_well_behind", actorIndex: playerIndex, deficit }, projectedPlayers);
      if (wasBehind && deficit <= 6) publishTableTalk({ type: "computer_catches_up", actorIndex: playerIndex, deficit }, projectedPlayers);
      scoreRaceStateRef.current[playerIndex] = { behind: isBehind };
    });

    if (final >= 121) {
      const winnerName = playerCount === 4 ? (team === 0 ? "You and Arthur" : "Mabel and Clara") : players[index].name;
      const winVerb = playerCount === 4 || winnerName === "You" ? "win" : "wins";
      setWinner(winnerName);
      announce(`${winnerName} ${winVerb} the game! The finish peg reached 121.`);
      publishTableTalk({ type: "game_won", winnerIndex: index, winnerTeam: team }, projectedPlayers);
      projectedPlayers.slice(1, playerCount).forEach((player, playerIndexOffset) => {
        const playerIndex = playerIndexOffset + 1;
        if (player.team !== team) publishTableTalk({ type: "game_lost", loserIndex: playerIndex, winnerTeam: team }, projectedPlayers);
      });
      sound("win");
      setPhase("gameover");
      return true;
    }
    return false;
  }

  function dealRound(basePlayers = players, dealerIndex = dealer) {
    const d = deck(); deckRef.current = d;
    sound("deal");
    const dealt = basePlayers.slice(0, playerCount).map(p => ({ ...p, hand: d.splice(0, handSize).sort((a,b)=>a.rank-b.rank) }));
    goPlayersRef.current.clear();
    pendingGoResolutionRef.current = null;
    if (cardPlayTimerRef.current !== null) window.clearTimeout(cardPlayTimerRef.current);
    cardPlayTimerRef.current = null;
    cardPlayAnimatingRef.current = false;
    setCardPlayAnimation(null);
    setPeggingHold(false);
    setPlayers(old => old.map((p, i) => dealt[i] ?? p)); setScoringHands([]); setCrib([]); setCut(null); setSelected([]); setPile([]); setRunning(0); setLastPegger(null); setBreakdown(null); setHandCounts([]); setTurn((dealerIndex + 1) % playerCount); setPhase("discard");
    const roundNumber = Math.floor(dealerIndex / playerCount) + 1;
    announce(`Round ${roundNumber}: choose ${needDiscard} card${needDiscard > 1 ? "s" : ""} for ${NAMES[dealerIndex]}’s crib.`);
    publishTableTalk({ type: "round_started", dealerIndex, roundNumber }, dealt);
  }

  function startGame() {
    const ps = NAMES.map((name, i) => ({ name, color: COLORS[i], hand: [] as Card[], score: 0, team: playerCount === 4 ? i % 2 : i }));
    const drawDeck = deck();
    const draws: OpeningDraw[] = [];
    let contenders = Array.from({ length: playerCount }, (_, i) => i);
    let round = 1;
    while (contenders.length > 1) {
      const roundDraws = contenders.map(player => ({ player, card: drawDeck.shift()!, round }));
      draws.push(...roundDraws);
      const lowest = Math.min(...roundDraws.map(draw => draw.card.rank));
      contenders = roundDraws.filter(draw => draw.card.rank === lowest).map(draw => draw.player);
      round++;
    }
    const firstDealer = contenders[0];
    const history: HistoryEntry[] = [];
    for (let drawRound = 1; drawRound < round; drawRound++) {
      const roundDraws = draws.filter(draw => draw.round === drawRound);
      history.push({ kind: "game", text: roundDraws.map(draw => `${NAMES[draw.player]} ${NAMES[draw.player] === "You" ? "draw" : "draws"} ${RANK(draw.card.rank)}${draw.card.suit}`).join(" · ") });
      const lowRank = Math.min(...roundDraws.map(draw => draw.card.rank));
      const tied = roundDraws.filter(draw => draw.card.rank === lowRank);
      if (tied.length > 1) history.push({ kind: "game", text: `${tied.map(draw => NAMES[draw.player]).join(" and ")} tie for low card and draw again.` });
    }
    history.push({ kind: "game", text: `${NAMES[firstDealer]} ${NAMES[firstDealer] === "You" ? "win" : "wins"} the draw and get${NAMES[firstDealer] === "You" ? "" : "s"} the first deal and crib.` });
    setPlayers(ps); setDealer(firstDealer); setWinner(""); setMessageHistory(history); setOpeningDraws(draws); setCut(null); setPhase("cutting");
    publishTableTalk({ type: "game_started" }, ps);
    publishTableTalk({ type: "first_crib_won", dealerIndex: firstDealer }, ps);
  }

  function beginFirstDeal() {
    setOpeningDraws([]);
    dealRound(players, dealer);
  }

  function toggleCard(id: string) { setSelected(s => s.includes(id) ? s.filter(x => x !== id) : s.length < needDiscard ? [...s, id] : s); }

  function finishDiscard() {
    if (selected.length !== needDiscard) return;
    sound("slide");
    const mine = players[0].hand.filter(c => selected.includes(c.id));
    const cribCards: Card[] = [];
    const updated = players.map((p, i) => {
      if (i >= playerCount) return p;
      const chosen = i === 0 ? mine : chooseAiDiscard(p.hand, i);
      cribCards.push(...chosen);
      return { ...p, hand: p.hand.filter(c => !chosen.some(x => x.id === c.id)) };
    });
    if (playerCount === 3) cribCards.push(deckRef.current.shift()!);
    const starter = deckRef.current.shift()!; setPlayers(updated); setCrib(cribCards); setScoringHands(updated.slice(0, playerCount).map(p => [...p.hand])); setCut(starter); setSelected([]); setPhase("pegging"); setTurn((dealer + 1) % playerCount); announce(`${RANK(starter.rank)}${starter.suit} is cut. Select a card to begin pegging.`);
    if (starter.rank === 11) addScore(dealer, 2, "his heels");
  }

  function chooseAiDiscard(hand: Card[], playerIndex: number) {
    if (difficulty === "easy") return [...hand].sort(() => Math.random() - .5).slice(0, needDiscard);
    const choices = combinations(hand, needDiscard);
    const possibleCuts = deckRef.current.filter(card => !hand.some(held => held.id === card.id));
    const ownsCrib = players[playerIndex]?.team === players[dealer]?.team;
    return choices.map(discarded => {
      const kept = hand.filter(card => !discarded.some(drop => drop.id === card.id));
      const sampleCuts = difficulty === "hard" ? possibleCuts : possibleCuts.filter((_, index) => index % 4 === 0);
      const handAverage = sampleCuts.reduce((sum, starter) => sum + scoreCards(kept, starter).total, 0) / Math.max(1, sampleCuts.length);
      const cribEffect = discardSynergy(discarded) * (ownsCrib ? 1 : -1);
      const danger = !ownsCrib && discarded.some(card => card.rank === 5) ? -3.5 : 0;
      return { discarded, rating: handAverage + cribEffect * (difficulty === "hard" ? .72 : .35) + danger };
    }).sort((a, b) => b.rating - a.rating)[0].discarded;
  }

  function pegPoints(next: Card, currentPile: Card[], total: number) {
    const cards = [...currentPile, next]; let pts = total + value(next) === 15 || total + value(next) === 31 ? 2 : 0;
    let same = 1; for (let i = cards.length - 2; i >= 0 && cards[i].rank === next.rank; i--) same++;
    if (same === 2) pts += 2; if (same === 3) pts += 6; if (same === 4) pts += 12;
    for (let len = Math.min(cards.length, 7); len >= 3; len--) { const ranks = cards.slice(-len).map(c=>c.rank).sort((a,b)=>a-b); if (new Set(ranks).size === len && ranks[len-1]-ranks[0] === len-1) { pts += len; break; } }
    return pts;
  }

  function playCard(index: number, card: Card) {
    if (cardPlayAnimatingRef.current || value(card) + running > 31) return;
    const source = document.querySelector<HTMLElement>(`[data-play-source="${index}-${CSS.escape(card.id)}"]`);
    const target = peggingTargetRef.current;
    if (!source || !target) {
      commitPlayCard(index, card);
      return;
    }
    const from = source.getBoundingClientRect();
    const to = target.getBoundingClientRect();
    cardPlayAnimatingRef.current = true;
    setCardPlayAnimation({
      card,
      playerIndex: index,
      faceDown: index > 0,
      left: from.left,
      top: from.top,
      width: from.width,
      height: from.height,
      dx: to.left + to.width / 2 - (from.left + from.width / 2),
      dy: to.top + to.height / 2 - (from.top + from.height / 2),
    });
    cardPlayTimerRef.current = window.setTimeout(() => {
      setCardPlayAnimation(null);
      cardPlayAnimatingRef.current = false;
      cardPlayTimerRef.current = null;
      commitPlayCard(index, card);
    }, 650);
  }

  function commitPlayCard(index: number, card: Card) {
    if (value(card) + running > 31) return;
    sound("card");
    const scoreEvents = peggingEvents(card, pile, running);
    const pts = scoreEvents.reduce((sum, event) => sum + event.points, 0);
    const nextTotal = running + value(card);
    const remaining = players.slice(0, playerCount).reduce((n,p,i)=>n+p.hand.length-(i===index?1:0),0);
    const lastCardPoint = remaining === 0 && nextTotal !== 31 ? 1 : 0;
    setPlayers(old => old.map((p,i)=>i===index?{...p,hand:p.hand.filter(c=>c.id!==card.id)}:p)); setPile(old => [...old, card]); setRunning(nextTotal);
    setLastPegger(index);
    announce(`${players[index].name} ${players[index].name === "You" ? "play" : "plays"} ${RANK(card.rank)}${card.suit}. Count: ${nextTotal}.`);
    if (shouldPublishFocusCommentaryForActor(index)) publishTableTalk({ type: "card_played", actorIndex: index, card: toPublicCard(card), runningTotal: nextTotal });
    if (pts + lastCardPoint) {
      scoreEvents.forEach(event => {
        if (shouldPublishFocusCommentaryForActor(index)) publishTableTalk({ type: "pegging_scored", actorIndex: index, points: event.points, kind: event.kind, runningTotal: nextTotal });
      });
      if (lastCardPoint && shouldPublishFocusCommentaryForActor(index)) publishTableTalk({ type: "last_card_scored", actorIndex: index, points: 1 });
      const won = addScore(index, pts + lastCardPoint, lastCardPoint ? (pts ? "pegging and last card" : "last card") : nextTotal === 31 ? "31" : "pegging");
      if (won) return;
    }
    if (nextTotal === 31) {
      setPeggingHold(true);
      window.setTimeout(() => {
        goPlayersRef.current.clear();
        setPile([]);
        setRunning(0);
        setLastPegger(null);
        setPeggingHold(false);
        if (!remaining) {
          beginCounting();
          return;
        }
        const nextAfterThirtyOne = Array.from({ length: playerCount }, (_, offset) => (index + offset + 1) % playerCount)
          .find(playerIndex => players[playerIndex].hand.some(held => held.id !== card.id || playerIndex !== index));
        setTurn(nextAfterThirtyOne ?? (index + 1) % playerCount);
      }, 1000);
      return;
    }
    if (!remaining) { setTimeout(() => beginCounting(), 500); return; }
    const nextPlayer = Array.from({ length: playerCount }, (_, offset) => (index + offset + 1) % playerCount)
      .find(playerIndex => {
        if (goPlayersRef.current.has(playerIndex)) return false;
        return players[playerIndex].hand.some(held => held.id !== card.id || playerIndex !== index);
      });
    setTurn(nextPlayer ?? (index + 1) % playerCount);
  }

  function chooseAiPeg(index: number, playable: Card[]) {
    if (difficulty === "easy") return playable[Math.floor(Math.random() * playable.length)];
    const opponents = players.slice(0, playerCount).filter((_, i) => i !== index && players[i].team !== players[index].team);
    return playable.map(card => {
      const nextTotal = running + value(card);
      let rating = pegPoints(card, pile, running) * 8;
      if (nextTotal === 5 || nextTotal === 10 || nextTotal === 21) rating -= difficulty === "hard" ? 4 : 1.5;
      if (nextTotal === 15 || nextTotal === 31) rating += 4;
      if (pile.length === 0 && card.rank === 5) rating -= 7;
      rating -= value(card) * .05;
      if (difficulty === "hard") {
        const replyScores = opponents.flatMap(opponent => opponent.hand
          .filter(reply => value(reply) + nextTotal <= 31)
          .map(reply => pegPoints(reply, [...pile, card], nextTotal)));
        rating -= (replyScores.length ? Math.max(...replyScores) : 0) * 3.2;
        const matchingReplies = opponents.reduce((sum, opponent) => sum + opponent.hand.filter(reply => reply.rank === card.rank).length, 0);
        rating -= matchingReplies * 1.5;
      }
      return { card, rating };
    }).sort((a, b) => b.rating - a.rating)[0].card;
  }

  function beginCounting() { setPhase("counting"); setTurn((dealer + 1) % playerCount); setPile([]); setRunning(0); setLastPegger(null); announce("Pegging complete. Count each hand, then the dealer’s crib."); }

  function sayGo(index: number) {
    if (index === lastPegger && goPlayersRef.current.size > 0) {
      finishGoSequence(index, lastPegger);
      return;
    }
    sound("go");
    goPlayersRef.current.add(index);
    announce(`${players[index].name} ${index === 0 ? "say" : "says"} Go.`);
    publishTableTalk({ type: "go_declared", actorIndex: index });

    const nextPlayer = Array.from({ length: playerCount - 1 }, (_, offset) => (index + offset + 1) % playerCount)
      .find(playerIndex => !goPlayersRef.current.has(playerIndex) && players[playerIndex].hand.length > 0);
    if (nextPlayer !== undefined) {
      setTurn(nextPlayer);
      return;
    }

    if (index > 0 && tableTalkLevel !== "off") {
      pendingGoResolutionRef.current = { declarer: index, lastPegger };
      return;
    }
    finishGoSequence(index, lastPegger);
  }

  function finishGoSequence(declarer: number, sequenceLastPegger: number | null) {
    if (sequenceLastPegger !== null && addScore(sequenceLastPegger, 1, "go")) return;
    const cardsRemain = players.slice(0, playerCount).some(p => p.hand.length > 0);
    if (!cardsRemain) { setTimeout(() => beginCounting(), 500); return; }

    const startAfter = sequenceLastPegger ?? declarer;
    const nextLeader = Array.from({ length: playerCount }, (_, offset) => (startAfter + offset + 1) % playerCount)
      .find(i => players[i].hand.length > 0);
    goPlayersRef.current.clear();
    setPile([]); setRunning(0); setLastPegger(null);
    setTurn(nextLeader ?? 0);
  }

  function countCurrent() {
    if (!cut || turn < 0 || phase !== "counting") return;
    sound("count");
    const countingPlayer = turn;
    const result = scoreCards(scoringHands[countingPlayer] ?? [], cut);
    setBreakdown(result);
    const countedCards = scoringHands[countingPlayer] ?? [];
    setHandCounts(old => [...old, { label: players[countingPlayer].name, color: players[countingPlayer].color, kind: "hand", cards: countedCards, cut, result }]);
    if (shouldPublishFocusCommentaryForActor(countingPlayer)) publishTableTalk({ type: "hand_revealed", actorIndex: countingPlayer, points: result.total });
    if (result.total >= 8 && shouldPublishFocusCommentaryForActor(countingPlayer)) publishTableTalk({ type: "large_hand_scored", actorIndex: countingPlayer, points: result.total });
    if (result.total === 0 && shouldPublishFocusCommentaryForActor(countingPlayer)) publishTableTalk({ type: "zero_point_hand", actorIndex: countingPlayer });
    const isFinalPlayerHandCount = countingPlayer === dealer;
    if (addScore(countingPlayer, result.total, "the hand", { suppressLeadChangedTalk: !isFinalPlayerHandCount })) return;

    // Counting begins to the dealer's left and continues in play order.
    // The dealer is therefore always the final hand counted.
    const next = (turn + 1) % playerCount;
    if (next === (dealer + 1) % playerCount) {
      const cribResult = scoreCards(crib.slice(0,4), cut, true);
      setBreakdown(cribResult);
      setHandCounts(old => [...old, { label: `${players[dealer].name}’s crib`, color: players[dealer].color, kind: "crib", cards: crib.slice(0,4), cut, result: cribResult }]);
      publishTableTalk({ type: "crib_revealed", ownerIndex: dealer });
      if (cribResult.total >= 8 && shouldPublishFocusCommentaryForOwner(dealer)) publishTableTalk({ type: "large_crib_scored", ownerIndex: dealer, points: cribResult.total });
      if (addScore(dealer, cribResult.total, "the crib", { suppressLeadChangedTalk: false })) return;
      announce(`${players[dealer].name} ${players[dealer].name === "You" ? "peg" : "pegs"} ${cribResult.total} for the crib. New score: ${Math.min(121, players[dealer].score + cribResult.total)}. Start the next deal when ready.`); setTurn(-1);
    } else setTurn(next);
  }

  function nextRound() { const nextDealer = (dealer + 1) % playerCount; setDealer(nextDealer); dealRound(players, nextDealer); }

  useEffect(() => {
    mutedRef.current = muted;
  }, [muted]);

  useEffect(() => {
    tableTalkVoiceEnabledRef.current = tableTalkVoiceEnabled;
  }, [tableTalkVoiceEnabled]);

  useEffect(() => {
    playersRef.current = players;
  }, [players]);

  useEffect(() => {
    pendingScoreByTeamRef.current = {};
  }, [players]);

  useEffect(() => {
    volumeRef.current = volume;
  }, [volume]);

  useEffect(() => {
    tableTalkRef.current?.setLevel(tableTalkLevel);
    saveTableTalkLevel(tableTalkLevel);
  }, [tableTalkLevel]);

  useEffect(() => {
    cloudTableTalkVoiceRef.current?.setEnabled(tableTalkVoiceEnabled && !muted);
    saveTableTalkVoiceEnabled(tableTalkVoiceEnabled);
  }, [tableTalkVoiceEnabled, muted]);

  useEffect(() => {
    cloudTableTalkVoiceRef.current?.setVolume(Math.max(0, Math.min(1, volume)));
  }, [volume]);

  useEffect(() => () => {
    cloudTableTalkVoiceRef.current?.cancel();
  }, []);

  useEffect(() => {
    if (cardPlayAnimation || peggingHold || tableTalkBlocking || phase !== "pegging" || turn <= 0 || turn >= playerCount) return;
    const timer = setTimeout(() => {
      const playable = players[turn].hand.filter(c => value(c) + running <= 31);
      if (playable.length) playCard(turn, chooseAiPeg(turn, playable));
      else sayGo(turn);
    }, 650); return () => clearTimeout(timer);
  }, [phase, turn, running, players, playerCount, tableTalkBlocking, peggingHold, cardPlayAnimation]);

  useEffect(() => {
    if (cardPlayAnimation || peggingHold || tableTalkBlocking || phase !== "pegging" || turn !== 0) return;
    if (!players.slice(0, playerCount).some(player => player.hand.length > 0)) return;
    if (players[0]?.hand.some(card => value(card) + running <= 31)) return;
    const timer = setTimeout(() => sayGo(0), 350);
    return () => clearTimeout(timer);
  }, [phase, turn, running, players, playerCount, tableTalkBlocking, peggingHold, cardPlayAnimation]);

  useEffect(() => {
    if (tableTalkBlocking || phase !== "counting" || turn <= 0) return;
    const timer = setTimeout(countCurrent, 800); return () => clearTimeout(timer);
  }, [phase, turn, tableTalkBlocking]);

  useEffect(() => {
    if (tableTalkBlocking || !pendingGoResolutionRef.current) return;
    const pending = pendingGoResolutionRef.current;
    pendingGoResolutionRef.current = null;
    finishGoSequence(pending.declarer, pending.lastPegger);
  }, [tableTalkBlocking]);

  useEffect(() => {
    setTurnReminder(false);
    if (phase !== "pegging" || turn < 0) return;
    const reminder = window.setTimeout(() => {
      setTurnReminder(true);
      window.setTimeout(() => setTurnReminder(false), 2400);
    }, 10_000);
    return () => window.clearTimeout(reminder);
  }, [phase, turn]);

  useEffect(() => {
    const window = messageWindowRef.current;
    if (window && shouldAutoScrollRef.current) window.scrollTop = window.scrollHeight;
  }, [messageHistory]);

  useEffect(() => {
    messageHistoryRef.current = messageHistory;
  }, [messageHistory]);

  const shownPlayers = useMemo(() => players.slice(0, playerCount), [players, playerCount]);

  return <main className="tabletop">
    <div className="game-shell" onClickCapture={event => {
      const button = (event.target as HTMLElement).closest("button");
      if (button && !button.classList.contains("card") && !button.classList.contains("sound-toggle")) sound("click");
    }}>
      <Board players={players} playerCount={playerCount} />
      {cardPlayAnimation && <div
        className="flying-card"
        style={{
          left: cardPlayAnimation.left,
          top: cardPlayAnimation.top,
          width: cardPlayAnimation.width,
          height: cardPlayAnimation.height,
          "--fly-x": `${cardPlayAnimation.dx}px`,
          "--fly-y": `${cardPlayAnimation.dy}px`,
        } as CSSProperties}
        aria-hidden="true"
      ><div className={`flying-card-inner ${cardPlayAnimation.faceDown ? "starts-down" : ""}`}>
        <div className="flying-card-back" />
        <div className={`flying-card-front ${cardPlayAnimation.card.suit === "♥" || cardPlayAnimation.card.suit === "♦" ? "warm" : ""}`}><span>{RANK(cardPlayAnimation.card.rank)}</span><b>{cardPlayAnimation.card.suit}</b><em>{cardPlayAnimation.card.suit}</em></div>
      </div></div>}
      <section className="play-area">
        <div className="status-bar"><span className="phase-tag">{phase === "menu" ? "Welcome" : phase}</span><div className="history-column"><strong className="history-title">Pegging history</strong><div className="message-window" onScroll={onHistoryScroll} ref={messageWindowRef} role="log" aria-live="polite" aria-label="Game and pegging history">{messageHistory.map((entry, i) => <p className={`${entry.kind === "dialogue" ? `dialogue ${entry.characterColor}` : ""} ${i === messageHistory.length - 1 ? "latest" : ""}`} key={`${i}-${asHistoryText(entry)}`}>{entry.kind === "dialogue" ? <><span className="speaker">{entry.characterName}:</span> “{formatDialogueText(entry.text, entry.scripted, entry.category)}”</> : entry.text}</p>)}</div></div><div className="sound-controls"><button className="quiet sound-toggle" onClick={() => { setMuted(value => !value); if (muted) setTimeout(() => sound("click"), 0); }} aria-pressed={muted}>{muted ? "Sound off" : "Sound on"}</button><label>Volume<input aria-label="Sound volume" type="range" min="0" max="1" step="0.05" value={volume} onChange={event => setVolume(Number(event.target.value))} /></label><button className="quiet" onClick={onExit ?? (() => setPhase("menu"))}>Mode select</button><a className="quiet home-link" href="https://vabgames.com" onClick={() => sound("click")}>Back to VABGames.com</a></div></div>
        {phase === "menu" ? <div className="menu-panel">
          <div><span className="eyebrow">A classic card-room game</span><h2>Pull up a chair.</h2><p>Play against up to three computer opponents. Four-player games use traditional partnerships.</p></div>
          <div className="menu-controls">
            <label>Number of players</label>
            <div className="player-picks">
              {[2,3,4].map(n => <button key={n} className={playerCount===n?"active":""} onClick={()=>setPlayerCount(n)}>{n}</button>)}
            </div>
            <label>Computer challenge</label>
            <div className="difficulty-picks">
              {(["easy","medium","hard"] as Difficulty[]).map(level => <button key={level} className={difficulty===level?"active":""} onClick={()=>setDifficulty(level)}>{level}</button>)}
            </div>
            <label>Table Talk</label>
            <div className="table-talk-picks">
              {(["off","occasional","chatty"] as TableTalkLevel[]).map(level => <button key={level} className={tableTalkLevel===level?"active":""} onClick={()=>setTableTalkLevel(level)}>{level}</button>)}
            </div>
            <label>Table Talk voice</label>
            <div className="table-talk-voice-picks">
              <button className={tableTalkVoiceEnabled ? "active" : ""} onClick={() => setTableTalkVoiceEnabled(true)}>on</button>
              <button className={!tableTalkVoiceEnabled ? "active" : ""} onClick={() => setTableTalkVoiceEnabled(false)}>off</button>
            </div>
            <p className="difficulty-note">{difficulty === "easy" ? "Relaxed play with occasional computer mistakes." : difficulty === "medium" ? "Balanced opponents that make sensible choices." : "Skilled opponents that evaluate hands, cribs, and pegging replies."}</p>
            <p className="table-talk-note">
              {tableTalkLevel === "off" ? "No personality comments are shown." : tableTalkLevel === "occasional" ? "Comments appear on notable moments." : "Characters chat more often, with cooldowns to avoid spam."}
              {" "}
              {!tableTalkVoiceEnabled
                ? "Voice is currently off."
                : "Voice uses prerecorded character clips."}
            </p>
            <button className="primary" onClick={startGame}>Start game</button>
            <button className="quit" onClick={()=>announce("Thanks for playing. You can close this tab whenever you’re ready.")}>Quit</button>
          </div>
        </div> : phase === "cutting" ? <div className="opening-draw">
          <span className="eyebrow">Cut for first crib</span>
          <h2>Low card deals first</h2>
          {Array.from(new Set(openingDraws.map(draw => draw.round))).map(round => <div className="draw-round" key={round}>
            {round > 1 && <strong>Tie-break draw</strong>}
            <div>{openingDraws.filter(draw => draw.round === round).map(draw => <article key={`${round}-${draw.player}`}><span className={`player-token ${players[draw.player]?.color}`} /><b>{players[draw.player]?.name}</b><CardView card={draw.card} /></article>)}</div>
          </div>)}
          <p><strong>{players[dealer]?.name}</strong> {dealer === 0 ? "win" : "wins"} the first deal and crib.</p>
          <button className="primary" onClick={beginFirstDeal}>Deal first hand</button>
        </div> : <>
          <div className="table-center">
            <div className="pile-zone"><span>PEGGING COUNT</span><strong>{running}</strong><div className="mini-pile" ref={peggingTargetRef} aria-label="Cards played in the current pegging sequence">{pile.map(c=><CardView key={c.id} card={c} small />)}</div></div>
            <div className="cut-zone"><span>STARTER CARD</span>{cut ? <CardView card={cut} small /> : <div className="card-placeholder" />}</div>
            <div className="count-box"><span>HAND COUNT</span>{handCounts.length ? <div className="hand-count-list">{handCounts.map((count, i) => <div className="hand-count-row" key={`${count.kind}-${count.label}-${i}`}><div className="hand-count-heading"><span className={`count-token ${count.color}`} /><strong>{count.label}</strong><div className="counted-cards">{[...count.cards, count.cut].map(card => <CountCard key={card.id} card={card} tableCard={card.id === count.cut.id} />)}</div><b>{count.result.total}</b></div><div className="score-events">{count.result.events.length ? count.result.events.map((event, eventIndex) => <div className="score-event" key={`${event.label}-${eventIndex}`}><span>{event.label}</span><div>{event.cards.map(card => <CountCard key={card.id} card={card} tableCard={card.id === count.cut.id} />)}</div><b>+{event.points}</b></div>) : <div className="score-event zero"><span>No scoring combinations</span><b>+0</b></div>}</div></div>)}</div> : breakdown ? <p>Counting hands…</p> : <p>Scores will appear here.</p>}{phase === "counting" && turn === -1 && <div className="crib-reveal"><strong>{dealer === 0 ? "Your crib" : `${players[dealer]?.name}’s crib`}</strong><div>{crib.slice(0,4).map(card => <CardView key={card.id} card={card} small />)}</div></div>}</div>
            <div className="action-zone">{phase === "discard" && <button className="primary" disabled={selected.length!==needDiscard} onClick={finishDiscard}>Send {needDiscard} to crib</button>}{phase === "pegging" && turn===0 && !players[0]?.hand.some(c=>value(c)+running<=31) && <span className="forced-go">Passing…</span>}{phase === "counting" && turn===0 && <button className="primary" onClick={countCurrent}>Count my hand</button>}{phase === "counting" && turn===-1 && <button className="primary" onClick={nextRound}>Next deal</button>}</div>
          </div>
          <div className="players">{shownPlayers.map((p, i) => {
            const shownHand = phase === "counting" ? (scoringHands[i] ?? []) : p.hand;
            const isSpeaker = tableTalkPlayback?.line.characterName === p.name;
            const isNextSpeaker = nextTableTalkSpeaker === p.name;
            const isCribOwner = i === dealer;
            const cribCards = crib.slice(0, 4);
            const showCribStrip = isCribOwner && cribCards.length > 0;
            const revealCribCards = phase === "counting" && turn === -1;
            return <article className={`player seat-${i} ${turn === i ? "turn" : ""} ${turn === i && turnReminder ? "turn-reminder" : ""} ${isSpeaker ? "talking" : ""} ${isNextSpeaker ? "talking-next" : ""}`} aria-label={`${p.name}, score ${p.score}${turn === i ? ", active player" : ""}`} key={p.name}>
              <header>{i > 0 ? <div className={`player-portrait ${p.color}`} aria-hidden="true">{p.name[0]}</div> : <span className={`player-token ${p.color}`} />}<h3>{p.name}</h3><AnimatedScore score={p.score} />{i > 0 && <small>AI</small>}</header>
              {isSpeaker && <div className="player-caption" role="status" aria-live="polite"><div className="caption-status"><span>{tableTalkPlayback.phase === "intro" ? `${p.name} is about to speak` : tableTalkPlayback.phase === "loading" ? "Loading voice…" : tableTalkPlayback.phase === "reading" ? "Take a moment…" : `${p.name} is speaking`}</span>{tableTalkPlayback.phase === "loading" && <div className="voice-meter" role="progressbar" aria-label="Loading voice"><i /></div>}</div>{(tableTalkPlayback.phase === "speaking" || tableTalkPlayback.phase === "reading") && <p>“{formatDialogueText(tableTalkPlayback.line.text, true, tableTalkPlayback.line.eventType)}”</p>}{tableTalkPlayback.phase !== "intro" && <button className="caption-continue" onClick={continueTableTalk}>Continue</button>}</div>}
              {isNextSpeaker && !isSpeaker && <div className="next-speaker-label">Up next: {p.name}</div>}
              <div className="hand">{shownHand.map(c => <CardView key={c.id} card={c} playSource={`${i}-${c.id}`} animating={cardPlayAnimation?.playerIndex === i && cardPlayAnimation.card.id === c.id} hidden={i > 0 && phase !== "counting"} selected={selected.includes(c.id)} onClick={i === 0 && phase === "discard" ? () => toggleCard(c.id) : i === 0 && phase === "pegging" && turn === 0 && !peggingHold && !cardPlayAnimation ? () => playCard(0, c) : undefined} />)}</div>
              {showCribStrip && <div className="crib-strip" aria-label={`${p.name}'s crib`}>
                <strong>{i === 0 ? "My crib" : `${p.name}'s crib`}</strong>
                <div className="crib-strip-cards">
                  {cribCards.map(card => <CardView key={`crib-${card.id}`} card={card} small hidden={!revealCribCards} />)}
                </div>
              </div>}
            </article>;
          })}</div>
        </>}
      </section>
      {phase === "gameover" && <div className="modal"><div><span>★ GAME ★</span><h2>{winner} {playerCount === 4 || winner === "You" ? "win" : "wins"}!</h2><p>The finish peg has reached 121.</p><button className="primary" onClick={()=>setPhase("menu")}>Play again</button></div></div>}
    </div>
  </main>;
}
