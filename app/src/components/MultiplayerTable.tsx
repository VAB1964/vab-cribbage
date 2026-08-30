import { useEffect, useLayoutEffect, useMemo, useRef, useState } from "react";
import type { CSSProperties, ReactNode } from "react";
import { configureGameAudio, playGameSound, unlockGameAudio } from "../audio/gameAudio";
import { playScriptedDialogue } from "../audio/scriptedDialogue";
import { avatarById, type PlayerPreferences } from "../identity/preferences";
import { cardValue, isCard, type Card } from "../rules/cards";
import { scoreHand } from "../rules/handScoring";
import type { MultiplayerSnapshot, RoomMessage } from "../controllers/MultiplayerController";
import type { CommandType, ConnectionState } from "../multiplayer/protocol";

type Player = {
  id: string; name: string; avatarId?: string; seat: number | null; teamId?: string | null;
  connected?: boolean; isAI?: boolean; ready?: boolean; score?: number; hand?: Card[]; handCount?: number;
};
type Event = { id?: string; type: string; data: Record<string, unknown> };
type PegColor = "red" | "green" | "blue";
type Props = {
  view: MultiplayerSnapshot; playerId: string; preferences: PlayerPreferences; connection: ConnectionState; message?: RoomMessage;
  send: (type: CommandType, payload: unknown) => void; onLeave: () => void;
};
type PendingPlayAnimation = {
  presentationId: string;
  playerId: string;
  card: Card;
  left: number;
  top: number;
  dx: number;
  dy: number;
  faceDown: boolean;
  status: "preparing" | "animating";
};
type PegPresentation = {
  presentationId: string;
  sourceEventId?: string;
  type: "play" | "go" | "last" | "reset";
  playerId: string;
  name: string;
  isAI: boolean;
  card?: Card;
  cardText?: string;
  reason: string;
  previousCount: number;
  resultingCount: number;
  points: number;
  score?: number;
  status: "queued" | "preparing" | "animating" | "completing";
};
const isPegNoticeType = (type: string) => type === "PEG_PLAY" || type === "PEG_GO" || type === "PEG_LAST";

function AvatarMark({ id, fallback = "●" }: { id?: string; fallback?: string }) {
  const avatar = avatarById(id);
  return avatar ? <img src={avatar.src} alt="" /> : fallback;
}

const object = (value: unknown): Record<string, unknown> | null => value && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : null;
const number = (value: unknown, fallback = 0) => typeof value === "number" && Number.isFinite(value) ? value : fallback;
const text = (value: unknown, fallback = "") => typeof value === "string" ? value : fallback;
const parseCard = (value: unknown): Card | null => {
  if (isCard(value)) return value;
  if (typeof value !== "string") return null;
  const match = /^(A|[2-9]|10|J|Q|K)([CDHS])$/.exec(value);
  if (!match) return null;
  const rank = ({ A: 1, J: 11, Q: 12, K: 13 } as Record<string, number>)[match[1]] ?? Number(match[1]);
  const suit = ({ C: "clubs", D: "diamonds", H: "hearts", S: "spades" } as const)[match[2] as "C" | "D" | "H" | "S"];
  return { rank: rank as Card["rank"], suit, id: `${rank}-${suit}` };
};
const encodeCard = (card: Card): string => `${rank(card.rank)}${({ clubs: "C", diamonds: "D", hearts: "H", spades: "S" } as const)[card.suit]}`;
const cards = (value: unknown): Card[] => Array.isArray(value) ? value.flatMap(item => {
  const candidate = object(item)?.card ?? item;
  const parsed = parseCard(candidate);
  return parsed ? [parsed] : [];
}) : [];
const phaseName = (view: MultiplayerSnapshot) => text(view.phase ?? object(view.game)?.phase, "lobby").toLowerCase();
const game = (view: MultiplayerSnapshot) => object(view.game) ?? view;
const playersFrom = (view: MultiplayerSnapshot): Player[] => {
  const raw = view.players ?? game(view).players;
  if (!Array.isArray(raw)) return [];
  return raw.flatMap(value => {
    const item = object(value);
    if (!item || typeof item.id !== "string") return [];
    const hand = cards(item.hand ?? item.cards);
    return [{ id: item.id, name: text(item.name, "Player"), avatarId: text(item.avatarId), seat: typeof item.seat === "number" ? item.seat : null,
      teamId: typeof item.teamId === "string" ? item.teamId : null, connected: item.connected !== false, isAI: item.isAI === true,
      ready: item.ready === true, score: number(item.score), hand, handCount: number(item.handCount ?? item.cardCount, hand.length) }];
  });
};
const eventKey = (event: Event, revision: number) => event.id ?? `${revision}:${event.type}:${JSON.stringify(event.data)}`;
const titlePhase = (phase: string) => ({ cut: "Cut for deal", cutting: "Cut for deal", discard: "Choose the crib", pegging: "Pegging", counting: "Counting", dealcomplete: "Deal complete", result: "Game result", complete: "Game result", session_summary: "Session summary", summary: "Session summary" }[phase] ?? phase.replaceAll("_", " "));
const rank = (value: number) => value === 1 ? "A" : value === 11 ? "J" : value === 12 ? "Q" : value === 13 ? "K" : String(value);
const suit = (value: Card["suit"]) => ({ clubs: "♣", diamonds: "♦", hearts: "♥", spades: "♠" }[value]);

function PlayingCard({ card, hidden, selected, disabled, onClick }: { card?: Card; hidden?: boolean; selected?: boolean; disabled?: boolean; onClick?: () => void }) {
  if (hidden || !card) return <span className="mp-card back" aria-label="Hidden card" />;
  const warm = card.suit === "diamonds" || card.suit === "hearts";
  return <button type="button" className={`mp-card ${warm ? "warm" : ""} ${selected ? "selected" : ""}`} disabled={disabled} onClick={onClick} aria-pressed={selected}>
    <b>{rank(card.rank)}</b><span>{suit(card.suit)}</span>
  </button>;
}

function CardNotation({ value }: { value: string }) {
  const parts: ReactNode[] = [];
  const pattern = /(10|[2-9AJQK])([CDHS])/g;
  let cursor = 0;
  for (const match of value.matchAll(pattern)) {
    const index = match.index;
    if (index > cursor) parts.push(value.slice(cursor, index));
    const suitCode = match[2] as "C" | "D" | "H" | "S";
    const suitGlyph = ({ C: "♣", D: "♦", H: "♥", S: "♠" } as const)[suitCode];
    parts.push(<span className={`mp-card-notation ${suitCode === "D" || suitCode === "H" ? "warm" : ""}`} key={`${index}-${match[0]}`}>{match[1]}{suitGlyph}</span>);
    cursor = index + match[0].length;
  }
  if (cursor < value.length) parts.push(value.slice(cursor));
  return <>{parts}</>;
}

function CribbageBoard({ lanes, moves }: {
  lanes: Array<{ id: string; label: string; score: number; color: PegColor }>;
  moves: Record<string, { from: number; to: number; amount: number }>;
}) {
  const winner = lanes.find(lane => lane.score >= 121);
  return <section className="mp-cribbage-board" aria-label="Cribbage scoreboard">
    {lanes.map(lane => <div className={`mp-board-lane ${lane.color}`} key={lane.id} aria-label={`${lane.label}: ${lane.score} points`}>
      <strong>{lane.label}</strong>
      <i className={`mp-end-hole ${lane.score === 0 ? `pegged ${lane.color}` : ""} ${moves[lane.id]?.from === 0 ? "has-ghost" : ""}`} aria-label="Start hole"><span /></i>
      <div className="mp-hole-track" aria-hidden="true">{Array.from({ length: 24 }, (_, groupIndex) => {
        const groupEnd = (groupIndex + 1) * 5;
        return <div className={`mp-hole-group ${groupEnd === 60 ? "double-skunk-line" : ""} ${groupEnd === 90 ? "skunk-line" : ""}`} key={groupIndex}>
          {Array.from({ length: 5 }, (_, offset) => {
            const hole = groupIndex * 5 + offset + 1;
            const move = moves[lane.id];
            const alreadyPegged = hole < Math.min(121, lane.score);
            const inTrail = Boolean(move && hole > move.from && hole <= move.to);
            return <i key={hole} className={`${alreadyPegged ? "already-pegged" : ""} ${hole === lane.score ? `pegged ${lane.color}` : ""} ${inTrail ? `score-trail ${lane.color}` : ""} ${move?.from === hole ? "has-ghost" : ""}`}>
              <span />{hole === lane.score && move?.amount ? <b className="mp-score-jump">+{move.amount}</b> : null}
            </i>;
          })}
        </div>;
      })}</div>
      <b>{lane.score}</b>
    </div>)}
    <div className={`mp-finish ${winner?.color ?? ""}`}><small>Finish</small><i className={`mp-end-hole ${winner ? `pegged ${winner.color}` : ""}`}><span /></i></div>
  </section>;
}

function CountReveal({ title, hand, starter, isCrib, points, canContinue, waiting, onContinue }: {
  title: string; hand: Card[]; starter?: Card; isCrib: boolean; points: number;
  canContinue: boolean; waiting: boolean; onContinue: () => void;
}) {
  const score = hand.length === 4 && starter ? scoreHand(hand, starter, isCrib) : null;
  const describe = (event: NonNullable<typeof score>["events"][number]) =>
    `${event.category === "fifteen" ? "Fifteen" : event.category[0].toUpperCase() + event.category.slice(1)}: ${event.cards.map(card => `${rank(card.rank)}${suit(card.suit)}`).join(" + ")} — ${event.points}`;
  return <div className="mp-count-modal" role="dialog" aria-modal="true" aria-labelledby="mp-count-title">
    <section>
      <span className="eyebrow">{isCrib ? "Crib count" : "Hand count"}</span>
      <h2 id="mp-count-title">{title}</h2>
      <div className="mp-count-cards">{hand.map(card => <PlayingCard card={card} key={card.id} disabled />)}
        {starter && <div className="mp-starter-count"><small>Starter</small><PlayingCard card={starter} disabled /></div>}
      </div>
      <div className="mp-count-breakdown">
        <h3>{points} points</h3>
        {score?.events.length ? <ul>{score.events.map((event, index) => <li key={`${event.category}-${index}`}>{describe(event)}</li>)}</ul> : <p>No scoring combinations.</p>}
      </div>
      <button className="primary" disabled={!canContinue || waiting} onClick={onContinue}>
        {waiting ? "Waiting for other players…" : canContinue ? "Accept count" : "Reviewing count…"}
      </button>
    </section>
  </div>;
}

export default function MultiplayerTable({ view, playerId, preferences, connection, message, send, onLeave }: Props) {
  const phase = phaseName(view);
  const state = game(view);
  const players = playersFrom(view).sort((a, b) => (a.seat ?? 99) - (b.seat ?? 99));
  const me = players.find(player => player.id === playerId);
  const [selected, setSelected] = useState<string[]>([]);
  const [countingHoldElapsed, setCountingHoldElapsed] = useState(true);
  const previousPresentationPhase = useRef(phase);
  const lastPeggingPile = useRef<Card[]>([]);
  const lastPeggingCount = useRef(0);
  const [history, setHistory] = useState<Array<{ key: string; text: string; dialogue: boolean }>>([]);
  const [showHistory, setShowHistory] = useState(false);
  const [pegPresentationQueue, setPegPresentationQueue] = useState<PegPresentation[]>([]);
  const [noticeVisible, setNoticeVisible] = useState(false);
  const [pendingPlayAnimation, setPendingPlayAnimation] = useState<PendingPlayAnimation | null>(null);
  const [hiddenPlayedCards, setHiddenPlayedCards] = useState<Set<string>>(() => new Set());
  const [pendingHandOverlayByPlayer, setPendingHandOverlayByPlayer] = useState<Record<string, number>>({});
  const [hiddenHandSlotByPlayer, setHiddenHandSlotByPlayer] = useState<Record<string, number>>({});
  const [pendingScoreOverlayByLane, setPendingScoreOverlayByLane] = useState<Record<string, number>>({});
  const pileTargetRef = useRef<HTMLDivElement>(null);
  const seen = useRef(new Set<string>());
  const discoveredPegNoticeIdsRef = useRef(new Set<string>());
  const completedPegNoticeIdsRef = useRef(new Set<string>());
  const completedPresentationIdsRef = useRef(new Set<string>());
  const playNoticesInitialized = useRef(false);
  const hand = cards(state.hand ?? state.localHand ?? me?.hand);
  const handCounts = object(state.handCounts);
  const teamScores = object(state.teamScores);
  const authoritativeHandCounts = Object.fromEntries(players.map(player => [player.id, number(handCounts?.[player.id], player.handCount)]));
  const authoritativeScores = Object.fromEntries(players.map(player => [players.length === 4 ? (player.teamId ?? "") : player.id, number(teamScores?.[players.length === 4 ? (player.teamId ?? "") : player.id], player.score)]));
  const laneIdForPlayer = (targetPlayerId: string) => {
    const target = players.find(player => player.id === targetPlayerId);
    return players.length === 4 ? (target?.teamId ?? "") : targetPlayerId;
  };
  const authoritativeRunningCount = number(state.runningCount ?? state.count);
  const authoritativePile = cards(state.pile ?? state.sequence ?? state.playedCards);
  if (phase === "pegging") {
    lastPeggingPile.current = authoritativePile;
    lastPeggingCount.current = authoritativeRunningCount;
  }
  const enteringCounting = phase === "counting" && previousPresentationPhase.current === "pegging";
  if (enteringCounting && authoritativePile.length >= lastPeggingPile.current.length) {
    lastPeggingPile.current = authoritativePile;
    if (authoritativeRunningCount > 0) lastPeggingCount.current = authoritativeRunningCount;
  }
  const countingEntryReady = !enteringCounting && countingHoldElapsed && pegPresentationQueue.length === 0 && !pendingPlayAnimation;
  const holdingFinalPeg = phase === "counting" && !countingEntryReady;
  const runningCount = holdingFinalPeg ? lastPeggingCount.current : phase === "counting" ? 0 : authoritativeRunningCount;
  const [presentedRunningCount, setPresentedRunningCount] = useState(authoritativeRunningCount);
  const displayRunningCount = holdingFinalPeg ? lastPeggingCount.current : phase === "counting" ? 0 : presentedRunningCount;
  const turnSeat = number(state.turnSeat, -1);
  const dealerSeat = number(state.dealerSeat, -1);
  const needed = number(state.discardCount ?? state.requiredDiscards, players.length === 2 ? 2 : 1);
  const legalIds = new Set(Array.isArray(state.legalCardIds) ? state.legalCardIds.filter((id): id is string => typeof id === "string") : hand.filter(card => cardValue(card) + runningCount <= 31).map(card => card.id));
  const myTurn = me?.seat === turnSeat;
  const canGoBase = phase === "pegging" && myTurn && hand.length > 0 && legalIds.size === 0;
  const hostId = text(view.hostPlayerId ?? state.hostPlayerId);
  const isHost = playerId === hostId;
  const host = players.find(player => player.id === hostId);
  const cut = cards(state.starterCard ? [state.starterCard] : state.cutCard ? [state.cutCard] : state.starter ? [state.starter] : [])[0];
  const pile = holdingFinalPeg ? lastPeggingPile.current : phase === "counting" ? [] : authoritativePile;
  const visiblePile = pile.filter(card => !hiddenPlayedCards.has(card.id));
  const ledger = object(view.sessionLedger ?? state.sessionLedger ?? view.ledger);
  const ledgerEntries = Array.isArray(ledger?.entries) ? ledger.entries.flatMap((entry) => {
    const record = object(entry);
    return record ? [record] : [];
  }) : [];
  const ledgerTotalsByPlayer = ledgerEntries.reduce<Record<string, number>>((totals, entry) => {
    const perPlayer = object(entry.perPlayerCents);
    if (!perPlayer) return totals;
    for (const [playerId, amount] of Object.entries(perPlayer)) {
      const cents = number(amount);
      totals[playerId] = (totals[playerId] ?? 0) + cents;
    }
    return totals;
  }, {});
  const ledgerPlayerNames = ledgerEntries.reduce<Record<string, string>>((names, entry) => {
    const playerRows = Array.isArray(entry.players) ? entry.players : [];
    for (const rawPlayer of playerRows) {
      const player = object(rawPlayer);
      const id = text(player?.playerId);
      if (!id) continue;
      names[id] = text(player?.name, names[id] ?? "Player");
    }
    return names;
  }, {});
  const formatCents = (cents: number) => `${cents < 0 ? "-" : "+"}$${Math.abs(cents / 100).toFixed(2)}`;
  const moneyClass = (cents: number) => cents < 0 ? "mp-money-negative" : cents > 0 ? "mp-money-positive" : "mp-money-neutral";
  const isResultPhase = ["result", "complete", "session_summary", "summary"].includes(phase);
  const winnerId = text(state.winnerTeamId);
  const winnerFromPlayers = players.find(player => player.id === winnerId || player.teamId === winnerId)?.name ?? "";
  const winner = text(state.winnerName ?? state.winnerTeamName ?? winnerFromPlayers);
  const cutCards = object(state.cutCards);
  const events = useMemo(() => {
    const dialogue = Array.isArray(view.dialogue) ? view.dialogue.flatMap(value => {
      const item = object(value);
      if (!item || typeof item.type !== "string") return [];
      const speaker = players.find(player => player.id === item.playerId);
      const details = object(item.data);
      return [{ id: text(item.id), type: item.type, data: { ...details, playerName: speaker?.name ?? "", message: text(details?.message, item.type.replaceAll("_", " ").toLowerCase()) } as Record<string, unknown> }];
    }) : [];
    return [...dialogue, ...(message?.events ?? []), ...(message?.event ? [message.event] : [])];
  }, [message, players, view.dialogue]);
  const hasUnprocessedPegNotice = Array.isArray(view.dialogue) && view.dialogue.some(value => {
    const item = object(value);
    if (!item || !isPegNoticeType(text(item.type))) return false;
    const id = text(item.id);
    if (!id) return true;
    return !completedPegNoticeIdsRef.current.has(id);
  });
  const countPresentationLocked = hasUnprocessedPegNotice || pegPresentationQueue.length > 0 || pendingPlayAnimation !== null || hiddenPlayedCards.size > 0;
  const pendingPegPresentation = phase === "pegging" && countPresentationLocked;
  const canGo = canGoBase && !pendingPegPresentation;
  const displayedHandCount = (targetPlayerId: string) => {
    const fallback = authoritativeHandCounts[targetPlayerId];
    return Math.max(0, fallback + number(pendingHandOverlayByPlayer[targetPlayerId]));
  };
  const hiddenHandSlots = (targetPlayerId: string) => Math.max(0, number(hiddenHandSlotByPlayer[targetPlayerId]));
  const displayedScoreForLane = (laneId: string) => {
    const authoritative = number(authoritativeScores[laneId]);
    const overlay = number(pendingScoreOverlayByLane[laneId]);
    return Math.max(0, authoritative - overlay);
  };

  function applyPresentedPegUpdate(presentation: PegPresentation) {
    setPresentedRunningCount(presentation.resultingCount);
    if (presentation.type === "play") {
      setPendingHandOverlayByPlayer(current => {
        const existing = number(current[presentation.playerId]);
        const next = Math.max(0, existing - 1);
        if (next === existing) return current;
        return { ...current, [presentation.playerId]: next };
      });
      setHiddenHandSlotByPlayer(current => {
        const existing = number(current[presentation.playerId]);
        if (existing <= 0) return current;
        return { ...current, [presentation.playerId]: existing - 1 };
      });
    }
    if (presentation.points > 0 && presentation.type !== "go") {
      const laneId = laneIdForPlayer(presentation.playerId);
      if (!laneId) return;
      setPendingScoreOverlayByLane(current => {
        const existing = number(current[laneId]);
        const next = Math.max(0, existing - presentation.points);
        if (next === existing) return current;
        return { ...current, [laneId]: next };
      });
    }
  }
  function markPegNoticeCompleted(eventId: string) {
    completedPegNoticeIdsRef.current.add(eventId);
  }
  function requestCardPlayAnimation(presentation: PegPresentation) {
    if (!presentation.card) return false;
    const playerRoot = document.querySelector<HTMLElement>(`[data-mp-player="${presentation.playerId}"]`);
    const source = playerRoot?.querySelector<HTMLElement>(".mp-hidden-hand, .mp-local-hand") ?? playerRoot;
    const target = pileTargetRef.current;
    if (!source || !target) return false;
    const sourceRect = source.getBoundingClientRect();
    const targetRect = target.getBoundingClientRect();
    const left = sourceRect.left + sourceRect.width / 2 - 28;
    const top = sourceRect.top + sourceRect.height / 2 - 40;
    const destinationLeft = targetRect.left + visiblePile.length * 36;
    const destinationTop = targetRect.top + 7;
    setPendingPlayAnimation({
      presentationId: presentation.presentationId,
      playerId: presentation.playerId,
      card: presentation.card,
      left,
      top,
      dx: destinationLeft - left,
      dy: destinationTop - top,
      faceDown: presentation.playerId !== playerId,
      status: "preparing",
    });
    return true;
  }

  useEffect(() => setSelected(ids => ids.filter(id => hand.some(card => card.id === id))), [view.revision]); // authoritative hand clears accepted choices
  useEffect(() => {
    const previous = previousPresentationPhase.current;
    previousPresentationPhase.current = phase;
    if (phase === "counting" && previous === "pegging") {
      setCountingHoldElapsed(false);
      const timer = window.setTimeout(() => setCountingHoldElapsed(true), 3000);
      return () => window.clearTimeout(timer);
    }
    if (phase !== "counting") setCountingHoldElapsed(true);
  }, [phase]);
  useEffect(() => {
    const additions: Array<{ key: string; text: string; dialogue: boolean }> = [];
    for (const event of events) {
      if (event.type === "COUNT_HAND" || event.type === "COUNT_CRIB") continue;
      const key = eventKey(event, view.revision);
      if (seen.current.has(key)) continue;
      seen.current.add(key);
      const speaker = text(event.data.speakerName ?? event.data.playerName);
      const body = text(event.data.text ?? event.data.message ?? event.data.summary, event.type.replaceAll("_", " ").toLowerCase());
      const diagnostic =
        event.type === "PEG_PLAY" ||
        event.type === "PEG_GO" ||
        event.type === "PEG_LAST" ||
        event.type === "COUNT_HAND" ||
        event.type === "COUNT_CRIB" ||
        event.type === "COUNT_AWARDED" ||
        event.type === "STARTER_JACK";
      additions.push({ key, text: diagnostic ? body : speaker ? `${speaker}: “${body}”` : body, dialogue: !diagnostic && Boolean(speaker || event.type.includes("DIALOGUE")) });
    }
    if (additions.length) setHistory(old => [...old, ...additions].slice(-80));
  }, [events, view.revision]);
  useLayoutEffect(() => {
    const dialogue = Array.isArray(view.dialogue) ? view.dialogue : [];
    if (!playNoticesInitialized.current) {
      for (const value of dialogue) {
        const item = object(value);
        const type = text(item?.type);
        if (!isPegNoticeType(type)) continue;
        const id = text(item?.id);
        if (!id) continue;
        discoveredPegNoticeIdsRef.current.add(id);
        completedPegNoticeIdsRef.current.add(id);
      }
      playNoticesInitialized.current = true;
      return;
    }
    const queuedCountTail = pegPresentationQueue.length
      ? pegPresentationQueue[pegPresentationQueue.length - 1]!.resultingCount
      : presentedRunningCount;
    let planningCount = queuedCountTail;
    const additions: PegPresentation[] = [];
    for (const value of dialogue) {
      const item = object(value);
      if (!item || !isPegNoticeType(text(item.type))) continue;
      const id = text(item.id);
      if (!id || discoveredPegNoticeIdsRef.current.has(id)) continue;
      const details = object(item.data);
      const type = item.type === "PEG_GO" ? "go" as const : item.type === "PEG_LAST" ? "last" as const : "play" as const;
      const resultingCount = number(details?.runningCount);
      const cardText = text(details?.card);
      const parsedCard = type === "play" ? parseCard(cardText) ?? undefined : undefined;
      if (planningCount > 0 && resultingCount < planningCount) {
        additions.push({
          presentationId: `${id}:reset-before`,
          type: "reset",
          playerId: text(item.playerId),
          name: "Table",
          isAI: false,
          reason: "reset",
          previousCount: planningCount,
          resultingCount: 0,
          points: 0,
          status: "queued",
        });
        planningCount = 0;
      }
      discoveredPegNoticeIdsRef.current.add(id);
      const player = players.find(candidate => candidate.id === item.playerId);
      const score = typeof details?.score === "number" && Number.isFinite(details.score) ? details.score : undefined;
      additions.push({
        presentationId: id,
        sourceEventId: id,
        type,
        playerId: text(item.playerId),
        name: player?.name ?? "Player",
        isAI: player?.isAI === true,
        card: parsedCard,
        cardText,
        reason: text(details?.reason, "no points"),
        previousCount: planningCount,
        resultingCount,
        points: number(details?.points),
        score,
        status: "queued",
      });
      planningCount = resultingCount;
      if (type === "play" && resultingCount === 31) {
        additions.push({
          presentationId: `${id}:reset-after`,
          type: "reset",
          playerId: text(item.playerId),
          name: "Table",
          isAI: false,
          reason: "31 reset",
          previousCount: 31,
          resultingCount: 0,
          points: 0,
          status: "queued",
        });
        planningCount = 0;
      }
    }
    if (additions.length) {
      setPendingHandOverlayByPlayer(current => {
        const next = { ...current };
        for (const notice of additions) {
          if (notice.type !== "play") continue;
          next[notice.playerId] = number(next[notice.playerId]) + 1;
        }
        return next;
      });
      setPendingScoreOverlayByLane(current => {
        const next = { ...current };
        for (const notice of additions) {
          if (!notice.sourceEventId || notice.type === "go" || notice.points <= 0) continue;
          const laneId = laneIdForPlayer(notice.playerId);
          if (!laneId) continue;
          next[laneId] = number(next[laneId]) + notice.points;
        }
        return next;
      });
      setHiddenPlayedCards(current => {
        const next = new Set(current);
        for (const notice of additions) {
          if (notice.type !== "play" || !notice.card) continue;
          next.add(notice.card.id);
        }
        return next;
      });
      setPegPresentationQueue(current => [...current, ...additions]);
    }
  }, [view.dialogue, view.revision, players, pegPresentationQueue, presentedRunningCount]);
  useEffect(() => {
    const pileIds = new Set(pile.map(card => card.id));
    setHiddenPlayedCards(current => {
      const next = new Set([...current].filter(id => pileIds.has(id)));
      return next.size === current.size ? current : next;
    });
  }, [phase, authoritativeRunningCount]);
  const canClearStaleHiddenCards = !hasUnprocessedPegNotice && pegPresentationQueue.length === 0 && pendingPlayAnimation === null;
  useEffect(() => {
    if (!canClearStaleHiddenCards) return;
    setHiddenPlayedCards(current => (current.size ? new Set() : current));
  }, [canClearStaleHiddenCards]);
  useEffect(() => {
    if (!countPresentationLocked) setPresentedRunningCount(authoritativeRunningCount);
  }, [authoritativeRunningCount, countPresentationLocked]);
  useEffect(() => {
    if (phase === "pegging") return;
    setPendingHandOverlayByPlayer({});
    setHiddenHandSlotByPlayer({});
    setPendingScoreOverlayByLane({});
  }, [phase]);
  useLayoutEffect(() => {
    if (!pendingPlayAnimation || pendingPlayAnimation.status !== "preparing") return;
    const frame = window.requestAnimationFrame(() => {
      setPendingPlayAnimation(current => {
        if (!current || current.presentationId !== pendingPlayAnimation.presentationId || current.status !== "preparing") return current;
        if (!preferences.reducedAnimation) {
          setHiddenHandSlotByPlayer(slots => ({ ...slots, [current.playerId]: number(slots[current.playerId]) + 1 }));
        }
        setPegPresentationQueue(queue => queue.length && queue[0]!.presentationId === current.presentationId
          ? [{ ...queue[0]!, status: "animating" }, ...queue.slice(1)]
          : queue);
        return { ...current, status: "animating" };
      });
    });
    return () => window.cancelAnimationFrame(frame);
  }, [pendingPlayAnimation, preferences.reducedAnimation]);
  function completePresentation(presentationId: string) {
    if (completedPresentationIdsRef.current.has(presentationId)) return;
    setPegPresentationQueue(queue => {
      if (!queue.length || queue[0]!.presentationId !== presentationId) return queue;
      const current = queue[0]!;
      completedPresentationIdsRef.current.add(presentationId);
      applyPresentedPegUpdate(current);
      if (current.type === "play" && current.card) {
        setHiddenPlayedCards(hidden => {
          const next = new Set(hidden);
          next.delete(current.card!.id);
          return next;
        });
      }
      if (current.sourceEventId) markPegNoticeCompleted(current.sourceEventId);
      setPendingPlayAnimation(animation => animation?.presentationId === presentationId ? null : animation);
      return queue.slice(1);
    });
  }
  useEffect(() => {
    if (!pegPresentationQueue.length) {
      setNoticeVisible(false);
      return;
    }
    const current = pegPresentationQueue[0]!;
    setNoticeVisible(current.type !== "reset");
    if (current.status !== "queued") return;
    if (current.type === "play" && current.card && !preferences.reducedAnimation) {
      const animationReady = requestCardPlayAnimation(current);
      setPegPresentationQueue(queue => queue.length && queue[0]!.presentationId === current.presentationId
        ? [{ ...queue[0]!, status: animationReady ? "preparing" : "completing" }, ...queue.slice(1)]
        : queue);
      return;
    }
    setPegPresentationQueue(queue => queue.length && queue[0]!.presentationId === current.presentationId
      ? [{ ...queue[0]!, status: "completing" }, ...queue.slice(1)]
      : queue);
  }, [pegPresentationQueue, preferences.reducedAnimation]);
  useEffect(() => {
    if (!pendingPlayAnimation || pendingPlayAnimation.status !== "animating") return;
    const current = pegPresentationQueue[0];
    if (!current || current.presentationId !== pendingPlayAnimation.presentationId) return;
    const timer = window.setTimeout(() => {
      setPegPresentationQueue(queue => queue.length && queue[0]!.presentationId === current.presentationId
        ? [{ ...queue[0]!, status: "completing" }, ...queue.slice(1)]
        : queue);
    }, 1150);
    return () => window.clearTimeout(timer);
  }, [pendingPlayAnimation, pegPresentationQueue]);
  useEffect(() => {
    if (!pegPresentationQueue.length) return;
    const current = pegPresentationQueue[0]!;
    if (current.status !== "completing") return;
    if (current.type !== "reset" && current.isAI && preferences.soundEnabled) {
      const key = current.type === "go" ? "go_declared"
        : current.type === "last" ? "self_last_card"
        : current.reason.includes("makes 31") ? "self_thirty_one"
          : current.reason.includes("makes 15") ? "self_fifteen"
            : current.reason.includes("four of a kind") ? "self_double_pair_royal"
              : current.reason.includes("three of a kind") ? "self_pair_royal"
                : current.reason.includes("pairs") ? "self_pair"
                  : current.reason.includes("run") ? "self_pegging_run" : null;
      if (key) {
        const characterIds = ["mabel", "arthur", "clara"] as const;
        const characterId = characterIds[Math.max(0, players.findIndex(player => player.name === current.name)) % characterIds.length]!;
        void playScriptedDialogue(characterId, key, preferences.volume);
      }
    }
    const frame = window.requestAnimationFrame(() => completePresentation(current.presentationId));
    return () => {
      window.cancelAnimationFrame(frame);
    };
  }, [pegPresentationQueue, preferences.soundEnabled, preferences.volume, players]);

  const toggle = (id: string) => setSelected(old => {
    if (old.includes(id)) return old.filter(item => item !== id);
    const limit = phase === "pegging" ? 1 : needed;
    return old.length < limit ? [...old, id] : old;
  });
  const active = players.find(player => player.seat === turnSeat);
  const dealerPlayer = players.find(player => player.seat === dealerSeat);
  const opponentsInTurnOrder = players
    .filter(player => player.id !== playerId)
    .sort((left, right) => {
      const localSeat = me?.seat ?? 0;
      const leftDistance = ((left.seat ?? 0) - localSeat + players.length) % players.length;
      const rightDistance = ((right.seat ?? 0) - localSeat + players.length) % players.length;
      return leftDistance - rightDistance;
    });
  const hasDiscarded = phase === "discard" && hand.length === 4;
  const cribOwner = dealerPlayer?.id === playerId ? "your crib" : `${dealerPlayer?.name ?? "the dealer"}'s crib`;
  const turnMessage = phase === "discard"
    ? `Your turn. ${hasDiscarded ? `Waiting for the other players to discard for ${cribOwner}.` : `Discard ${needed} card${needed === 1 ? "" : "s"} for ${cribOwner}.`}`
    : phase === "pegging" && active
      ? `${active.id === playerId ? "Your" : `${active.name}'s`} turn. ${active.id === playerId ? (legalIds.size ? "Play a card." : "Say Go.") : "Waiting for their play."}`
      : active ? `${active.id === playerId ? "Your" : `${active.name}'s`} turn.` : titlePhase(phase);
  const activeNotice = noticeVisible ? pegPresentationQueue[0] : undefined;
  const flyingCard = pendingPlayAnimation?.status === "animating" ? pendingPlayAnimation : null;
  const activeNoticeScore = activeNotice ? (() => {
    if (typeof activeNotice.score === "number") return activeNotice.score;
    const laneId = laneIdForPlayer(activeNotice.playerId);
    return laneId ? displayedScoreForLane(laneId) : 0;
  })() : 0;
  const noticeContent = activeNotice ? activeNotice.type === "go"
    ? <><strong>{activeNotice.name} says Go!</strong><small>Running count: {activeNotice.resultingCount}</small></>
    : activeNotice.type === "last"
      ? <><strong>{activeNotice.name} pegs 1 for last card</strong><small>Score: {activeNoticeScore}</small></>
      : activeNotice.type === "reset"
        ? <><strong>Count resets</strong><small>Running count: 0</small></>
        : <><strong>{activeNotice.name} played <CardNotation value={activeNotice.cardText ?? ""} /></strong><span><CardNotation value={activeNotice.reason} /> · {activeNotice.points} point{activeNotice.points === 1 ? "" : "s"}</span><small>Running count: {activeNotice.resultingCount} · Score: {activeNoticeScore}</small></>
    : null;
  const cribCount = number(state.cribCount);
  const scoreLanes = players.length === 4
    ? (["gold", "green"] as const).map(teamId => ({
      id: teamId,
      label: `${teamId === "gold" ? "Red" : "Green"} · ${players.filter(player => player.teamId === teamId).map(player => player.name).join(" & ")}`,
      score: displayedScoreForLane(teamId),
      color: teamId === "gold" ? "red" as const : "green" as const,
    }))
    : players.map((player, index) => ({ id: player.id, label: player.name, score: displayedScoreForLane(player.id), color: (index === 2 ? "blue" : index === 1 ? "green" : "red") as PegColor }));
  const [scoreMoves, setScoreMoves] = useState<Record<string, { from: number; to: number; amount: number }>>({});
  const previousLaneScores = useRef<Record<string, number>>(Object.fromEntries(scoreLanes.map(lane => [lane.id, lane.score])));
  useEffect(() => {
    const nextScores = Object.fromEntries(scoreLanes.map(lane => [lane.id, lane.score]));
    const moves = Object.fromEntries(scoreLanes.flatMap(lane => {
      const from = previousLaneScores.current[lane.id] ?? lane.score;
      return lane.score > from ? [[lane.id, { from, to: lane.score, amount: lane.score - from }]] : [];
    }));
    previousLaneScores.current = nextScores;
    if (!Object.keys(moves).length) return;
    setScoreMoves(moves);
    const timer = window.setTimeout(() => setScoreMoves({}), 2400);
    return () => window.clearTimeout(timer);
  }, [view.revision]);
  const currentCount = object(state.currentCount);
  const alreadyAcknowledged = Array.isArray(state.acknowledgements) && state.acknowledgements.includes(playerId);
  const countedPlayer = players.find(player => player.id === currentCount?.playerId);
  const [aiReviewReady, setAiReviewReady] = useState(true);
  useEffect(() => {
    if (!countedPlayer?.isAI) { setAiReviewReady(true); return; }
    setAiReviewReady(false);
    const timer = window.setTimeout(() => setAiReviewReady(true), 2500);
    return () => window.clearTimeout(timer);
  }, [countedPlayer?.isAI, currentCount?.eventId]);
  const countedCards = cards(currentCount?.cards);
  const countStarter = parseCard(currentCount?.starterCard);
  const [countRevealReady, setCountRevealReady] = useState(true);
  const [countPegging, setCountPegging] = useState<{ name: string; points: number; score: number; color: PegColor } | null>(null);
  const previousCountForPeg = useRef<{ eventId: string; name: string; teamId: string; points: number; color: PegColor } | null>(null);
  const playerPegColor = (targetId: unknown): PegColor => {
    const index = players.findIndex(player => player.id === targetId);
    if (players.length === 4) return players[index]?.teamId === "green" ? "green" : "red";
    return index === 2 ? "blue" : index === 1 ? "green" : "red";
  };
  const [showCutResult, setShowCutResult] = useState(false);
  const previousPhase = useRef<string | undefined>(undefined);
  const previousPlayed = useRef(JSON.stringify(state.playedCards ?? []));
  const previousScores = useRef(JSON.stringify(teamScores ?? {}));
  const previousCountEvent = useRef("");
  const previousDealNumber = useRef(number(state.dealNumber));
  useEffect(() => configureGameAudio(preferences.soundEnabled, preferences.volume), [preferences.soundEnabled, preferences.volume]);
  useEffect(() => {
    const unlock = () => unlockGameAudio();
    window.addEventListener("pointerdown", unlock, { capture: true });
    window.addEventListener("keydown", unlock, { capture: true });
    return () => {
      window.removeEventListener("pointerdown", unlock, { capture: true });
      window.removeEventListener("keydown", unlock, { capture: true });
    };
  }, []);
  useEffect(() => {
    const oldPhase = previousPhase.current;
    if (phase === "cut" && oldPhase !== "cut") playGameSound("shuffle");
    if (phase === "discard" && oldPhase === "cut") {
      playGameSound("deal");
      setShowCutResult(true);
      const timer = window.setTimeout(() => setShowCutResult(false), 3000);
      previousPhase.current = phase;
      return () => window.clearTimeout(timer);
    }
    previousPhase.current = phase;
  }, [phase]);
  useEffect(() => {
    const played = JSON.stringify(state.playedCards ?? []);
    if (phase === "pegging" && played !== previousPlayed.current) playGameSound("card");
    previousPlayed.current = played;
  }, [phase, state.playedCards]);
  useEffect(() => {
    const scores = JSON.stringify(teamScores ?? {});
    if (phase === "pegging" && scores !== previousScores.current) playGameSound("peg");
    previousScores.current = scores;
  }, [phase, teamScores]);
  useEffect(() => {
    const eventId = text(currentCount?.eventId);
    if (phase === "counting" && eventId && eventId !== previousCountEvent.current && !previousCountForPeg.current) playGameSound("count");
    previousCountEvent.current = eventId;
  }, [currentCount?.eventId, phase]);
  useEffect(() => {
    const eventId = text(currentCount?.eventId);
    const previous = previousCountForPeg.current;
    if (previous && eventId !== previous.eventId) {
      setCountRevealReady(false);
      setCountPegging({
        name: previous.name,
        points: previous.points,
        score: displayedScoreForLane(previous.teamId),
        color: previous.color,
      });
      playGameSound("peg");
      const timer = window.setTimeout(() => {
        setCountPegging(null);
        setCountRevealReady(true);
        if (eventId) playGameSound("count");
      }, 2400);
      previousCountForPeg.current = eventId ? {
        eventId,
        name: currentCount?.kind === "crib" ? `${countedPlayer?.name ?? "Dealer"}'s crib` : countedPlayer?.name ?? "Player",
        teamId: text(currentCount?.teamId),
        points: number(currentCount?.points),
        color: playerPegColor(currentCount?.playerId),
      } : null;
      return () => window.clearTimeout(timer);
    }
    if (!previous && eventId) {
      previousCountForPeg.current = {
        eventId,
        name: currentCount?.kind === "crib" ? `${countedPlayer?.name ?? "Dealer"}'s crib` : countedPlayer?.name ?? "Player",
        teamId: text(currentCount?.teamId),
        points: number(currentCount?.points),
        color: playerPegColor(currentCount?.playerId),
      };
      setCountRevealReady(true);
    }
  }, [currentCount?.eventId, phase]);
  useEffect(() => {
    const dealNumber = number(state.dealNumber);
    if (dealNumber > previousDealNumber.current && dealNumber > 1) {
      playGameSound("shuffle");
      const timer = window.setTimeout(() => playGameSound("deal"), 420);
      previousDealNumber.current = dealNumber;
      return () => window.clearTimeout(timer);
    }
    previousDealNumber.current = dealNumber;
  }, [state.dealNumber]);

  return <main className="mp-table">
    <header className="mp-board">
      <div><span className="eyebrow">Private table · {titlePhase(phase)}</span><h1>Cribbage</h1></div>
      <div className="mp-game-actions"><div className={`mp-connection ${connection}`}>{connection === "connected" ? "Live" : "Reconnecting…"}</div><button className="quiet" onClick={() => setShowHistory(true)}>History</button><button className="quiet" onClick={onLeave}>Leave table</button></div>
      <CribbageBoard lanes={scoreLanes} moves={scoreMoves} />
    </header>
    {countPegging && <div className={`mp-count-pegging ${countPegging.color}`} role="status" aria-live="assertive">
      <strong>{countPegging.name} pegs {countPegging.points}</strong>
      <span>Score: {countPegging.score}</span>
    </div>}
    {flyingCard && <div className="mp-flying-card" style={{ left: flyingCard.left, top: flyingCard.top, "--mp-fly-x": `${flyingCard.dx}px`, "--mp-fly-y": `${flyingCard.dy}px` } as CSSProperties} aria-hidden="true">
      <div className={`mp-flying-card-inner ${flyingCard.faceDown ? "starts-down" : ""}`}>
        <span className="mp-card back" />
        <PlayingCard card={flyingCard.card} disabled />
      </div>
    </div>}
    <section className="mp-tabletop" style={{ gridTemplateColumns: `repeat(${players.length},minmax(0,1fr))` }}>
      <div className="mp-center">
        {(phase === "cut" || showCutResult) && cutCards && Object.keys(cutCards).length > 0 && <div className={`mp-cut-reveal ${showCutResult ? "complete" : ""}`}>
          <strong>{showCutResult ? `${dealerPlayer?.name ?? "Low card"} cut low and deals` : "Low card deals"}</strong>
          <div>{players.map(player => {
            const card = parseCard(cutCards[player.id]);
            return <article className={showCutResult && player.seat === dealerSeat ? "dealer-cut" : ""} key={player.id}><span>{player.name}{showCutResult && player.seat === dealerSeat ? " · Dealer" : ""}</span>{card ? <PlayingCard card={card} disabled /> : <span className="mp-card back" />}</article>;
          })}</div>
        </div>}
        <div><small>Running count</small><strong className="mp-count">{displayRunningCount}</strong></div>
        <div><small>Played</small><div className="mp-pile" ref={pileTargetRef}>{visiblePile.map(card => <PlayingCard card={card} key={card.id} disabled />)}</div></div>
        <div><small>Starter</small>{cut ? <PlayingCard card={cut} disabled /> : <span className="mp-card-slot" />}</div>
        <div className="mp-prompt"><strong>{turnMessage}</strong>
          {phase === "cut" && !object(state.cutCards)?.[playerId] && <button className="primary" onClick={() => { unlockGameAudio(); playGameSound("shuffle"); send("CUT_CARD", {}); }}>Cut card</button>}
          {phase === "discard" && !hasDiscarded && <button className="primary" disabled={selected.length !== needed} onClick={() => send("DISCARD", { cards: selected.map(id => encodeCard(hand.find(card => card.id === id)!)) })}>Send exactly {needed}</button>}
          {phase === "pegging" && myTurn && selected.length === 1 && <button className="primary" disabled={!legalIds.has(selected[0]) || pendingPegPresentation} onClick={() => send("PLAY_CARD", { card: encodeCard(hand.find(card => card.id === selected[0])!) })}>Play card</button>}
          {canGo && <button className="primary" onClick={() => send("SAY_GO", {})}>Say Go</button>}
          {phase === "dealcomplete" && isHost && <button className="primary" onClick={() => send("NEXT_DEAL", { eventId: state.pendingEventId })}>Next deal</button>}
        </div>
      </div>

      <article data-mp-player={playerId} className={`mp-player local ${myTurn ? "active" : ""}`}>
        {activeNotice?.playerId === playerId && <div className="mp-player-notice" role="status" aria-live="polite">{noticeContent}</div>}
        <span className="mp-avatar"><AvatarMark id={me?.avatarId} /></span>
        <div><strong>{me?.name ?? "You"}{me?.seat === dealerSeat ? " · Dealer" : ""}</strong><small>{myTurn ? "Your turn" : "Your hand"}</small></div>
        <div className="mp-local-hand">{hand.map(card => <PlayingCard card={card} key={card.id} selected={selected.includes(card.id)} disabled={phase !== "discard" && !(phase === "pegging" && myTurn && legalIds.has(card.id) && !pendingPegPresentation)} onClick={() => toggle(card.id)} />)}</div>
        {me?.seat === dealerSeat && cribCount > 0 && <div className="mp-crib-strip"><strong>Your crib</strong><div>{Array.from({ length: cribCount }, (_, index) => <PlayingCard hidden key={index} />)}</div></div>}
      </article>
      <div className="mp-opponents">{opponentsInTurnOrder.map(player => <article data-mp-player={player.id} key={player.id} className={`mp-player ${player.seat === turnSeat ? "active" : ""}`}>
        {activeNotice?.playerId === player.id && <div className="mp-player-notice" role="status" aria-live="polite">{noticeContent}</div>}
        <span className="mp-avatar"><AvatarMark id={player.avatarId} /></span>
        <div><strong>{player.name}{player.seat === dealerSeat ? " · Dealer" : ""}</strong><small>{player.connected === false ? "Disconnected" : player.isAI ? "Computer" : player.seat === turnSeat ? "Playing" : "Waiting"}</small></div>
        <div className="mp-hidden-hand">{Array.from({ length: displayedHandCount(player.id) }, (_, index) => {
          const slotCount = displayedHandCount(player.id);
          const hiddenSlots = hiddenHandSlots(player.id);
          const hideSlot = hiddenSlots > 0 && index >= slotCount - hiddenSlots;
          return <span key={index} style={hideSlot ? { visibility: "hidden" } : undefined}><PlayingCard hidden /></span>;
        })}</div>
        {player.seat === dealerSeat && cribCount > 0 && <div className="mp-crib-strip"><strong>{player.name}'s crib</strong><div>{Array.from({ length: cribCount }, (_, index) => <PlayingCard hidden key={index} />)}</div></div>}
      </article>)}</div>

    </section>

    {isResultPhase && <div className="mp-result-modal" role="dialog" aria-modal="true" aria-labelledby="mp-result-title">
      <section>
        <h2 id="mp-result-title">{winner ? `${winner} Wins` : "Game Complete"}</h2>
        <div className="mp-result-actions">
          <button className="primary" onClick={() => send(isHost ? "REMATCH" : "REQUEST_REMATCH", {})}>Rematch</button>
          <button className="quiet" onClick={onLeave}>Quit</button>
        </div>
        {ledger && <>
          <h3>Current Balance</h3>
          <div className="mp-ledger mp-result-balance">{players.map(player => {
            const total = ledgerTotalsByPlayer[player.id] ?? 0;
            return <span key={player.id}>{player.name} <b className={moneyClass(total)}>{formatCents(total)}</b></span>;
          })}</div>
          <div className="mp-result-games">
            {ledgerEntries.map((entry, index) => {
              const perPlayer = object(entry.perPlayerCents) ?? {};
              const resultLabel = text(entry.result, "normal");
              const multiplier = number(entry.multiplier, 1);
              const gameNumber = number(entry.gameNumber, index + 1);
              return <p key={`${gameNumber}-${index}`}><strong>Game {gameNumber}</strong> ({resultLabel} x{multiplier})
                {Object.entries(perPlayer).map(([playerId, cents], detailIndex) => {
                  const amount = number(cents);
                  const name = ledgerPlayerNames[playerId] ?? players.find(player => player.id === playerId)?.name ?? "Player";
                  return <span key={`${gameNumber}-${playerId}`}>{detailIndex === 0 ? " " : " · "}{name} <b className={moneyClass(amount)}>{formatCents(amount)}</b></span>;
                })}
              </p>;
            })}
          </div>
        </>}
      </section>
    </div>}

    {connection !== "connected" && <div className="mp-reconnect" role="status"><strong>Reconnecting to the table…</strong><span>Your table is preserved.</span></div>}
    {host?.connected === false && <div className="mp-host-warning">Host disconnected. Host controls resume when they reconnect.</div>}
    {isHost && typeof state.pausedForPlayerId === "string" && <div className="mp-host-warning"><strong>Player disconnected</strong>
      <button onClick={() => send("WAIT_FOR_PLAYER", { playerId: state.pausedForPlayerId })}>Wait</button>
      <button onClick={() => send("REPLACE_WITH_AI", { playerId: state.pausedForPlayerId, difficulty: "medium" })}>Replace with AI</button>
      <button onClick={() => send("END_GAME", {})}>End game</button>
    </div>}
    {phase === "counting" && countingEntryReady && countRevealReady && currentCount && countStarter && <CountReveal
      title={currentCount.kind === "crib" ? `${countedPlayer?.name ?? "Dealer"}'s crib` : `${countedPlayer?.name ?? "Player"}'s hand`}
      hand={countedCards} starter={countStarter} isCrib={currentCount.kind === "crib"} points={number(currentCount.points)}
      canContinue={aiReviewReady} waiting={alreadyAcknowledged}
      onContinue={() => send("ACK_COUNT", { eventId: state.pendingEventId })}
    />}
    {showHistory && <div className="mp-history-modal" role="dialog" aria-modal="true" aria-labelledby="mp-history-title" onClick={() => setShowHistory(false)}>
      <section onClick={event => event.stopPropagation()}><header><h2 id="mp-history-title">Game history</h2><button className="quiet" onClick={() => setShowHistory(false)} aria-label="Close history">Close</button></header><div role="log">{history.length ? history.map(item => <p className={item.dialogue ? "dialogue" : ""} key={item.key}>{item.text}</p>) : <p>Waiting for the deal…</p>}</div></section>
    </div>}
  </main>;
}
