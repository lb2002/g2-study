import { createEmptyCard, fsrs, Rating, State, type Card as FsrsCard, type Grade } from 'ts-fsrs';
import type { ReviewLogEntry, StoredSrs, StudyCard } from '../types';

/**
 * The glasses only have two comfortable grading gestures, so we map
 *   swipe up   -> Good
 *   swipe down -> Again
 * FSRS still gets real ratings; we just never emit Hard/Easy.
 */
export type Verdict = 'good' | 'again';

const scheduler = fsrs({ enable_fuzz: true, enable_short_term: true });

export function newSrs(now = new Date()): StoredSrs {
  return toStored(createEmptyCard(now));
}

export function toStored(c: FsrsCard): StoredSrs {
  return { ...c, due: c.due.getTime(), last_review: c.last_review?.getTime() };
}

export function fromStored(s: StoredSrs): FsrsCard {
  return { ...s, due: new Date(s.due), last_review: s.last_review ? new Date(s.last_review) : undefined };
}

export function grade(card: StudyCard, verdict: Verdict, now = new Date()): StudyCard {
  const rating: Grade = verdict === 'good' ? Rating.Good : Rating.Again;
  const { card: next } = scheduler.next(fromStored(card.srs), now, rating);
  return { ...card, srs: toStored(next) };
}

export function isNew(card: StudyCard): boolean {
  return card.srs.state === State.New;
}

export function isDue(card: StudyCard, now = Date.now()): boolean {
  return !isNew(card) && card.srs.due <= now;
}

export interface DeckStats {
  total: number;
  due: number;
  newCards: number;
  learning: number;
  nextDueAt?: number;
}

export function deckStats(cards: StudyCard[], now = Date.now()): DeckStats {
  const active = cards.filter((c) => c.status === 'active');
  const future = active.filter((c) => !isNew(c) && c.srs.due > now).map((c) => c.srs.due);
  return {
    total: active.length,
    due: active.filter((c) => isDue(c, now)).length,
    newCards: active.filter(isNew).length,
    learning: active.filter((c) => c.srs.state === State.Learning || c.srs.state === State.Relearning).length,
    nextDueAt: future.length ? Math.min(...future) : undefined,
  };
}

export interface QueueOptions {
  now?: number;
  /** Maximum cards in the round (commute budget). Infinity = all due + new allowance. */
  limit?: number;
  /** New cards still allowed today. */
  newAllowance: number;
}

/**
 * Build a review queue: overdue cards first (most overdue relative to their
 * interval first, i.e. the ones we are most likely to have forgotten), then new
 * cards in creation order, capped by the limit.
 */
export function buildQueue(cards: StudyCard[], opts: QueueOptions): StudyCard[] {
  const now = opts.now ?? Date.now();
  const limit = opts.limit ?? Infinity;
  const due = cards
    .filter((c) => c.status === 'active' && isDue(c, now))
    .map((c) => ({ c, urgency: (now - c.srs.due) / Math.max(1, c.srs.scheduled_days * 86_400_000) }))
    .sort((a, b) => b.urgency - a.urgency)
    .map((x) => x.c);
  const fresh = cards
    .filter((c) => c.status === 'active' && isNew(c))
    .sort((a, b) => a.createdAt - b.createdAt)
    .slice(0, Math.max(0, opts.newAllowance));
  return [...due, ...fresh].slice(0, limit);
}

/** New cards introduced today, from the review log. */
export function newCardsSeenToday(reviews: ReviewLogEntry[], cardsById: Map<string, StudyCard>, now = new Date()): number {
  const start = new Date(now);
  start.setHours(0, 0, 0, 0);
  const firstSeen = new Map<string, number>();
  for (const r of reviews) firstSeen.set(r.cardId, Math.min(firstSeen.get(r.cardId) ?? Infinity, r.at));
  let n = 0;
  firstSeen.forEach((at, id) => {
    const card = cardsById.get(id);
    if (at >= start.getTime() && card && card.srs.reps <= 3) n++;
  });
  return n;
}

/**
 * Median seconds per card from recent reviews, ignoring outliers (someone
 * looking away mid-card). Falls back to the default with too little history.
 */
export function secondsPerCard(reviews: ReviewLogEntry[], fallback: number): number {
  const xs = reviews
    .map((r) => r.durationMs / 1000)
    .filter((s) => s >= 1.5 && s <= 90)
    .sort((a, b) => a - b);
  if (xs.length < 8) return fallback;
  return Math.round(xs[Math.floor(xs.length / 2)] * 10) / 10;
}
