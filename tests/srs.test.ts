import { State } from 'ts-fsrs';
import { describe, expect, it } from 'vitest';
import { buildQueue, deckStats, grade, newSrs, secondsPerCard } from '../src/srs/scheduler';
import { ReviewSession } from '../src/srs/session';
import type { ReviewLogEntry, StudyCard } from '../src/types';

const T0 = new Date('2026-11-19T08:00:00Z').getTime();
const MIN = 60_000;
const DAY = 86_400_000;

function card(id: string, patch: Partial<StudyCard> = {}): StudyCard {
  return { id, lectureId: 'l', front: `Q ${id}?`, back: `A ${id}`, sourceSnippet: '', status: 'active', createdAt: T0, srs: newSrs(new Date(T0)), ...patch };
}

function reviewed(id: string, dueOffsetMs: number, scheduledDays = 1): StudyCard {
  const c = card(id);
  return { ...c, srs: { ...c.srs, state: State.Review, due: T0 + dueOffsetMs, scheduled_days: scheduledDays, reps: 3 } };
}

describe('grade', () => {
  it('moves a new card forward on good and keeps it close on again', () => {
    const c = card('a');
    const good = grade(c, 'good', new Date(T0));
    const again = grade(c, 'again', new Date(T0));
    expect(good.srs.reps).toBe(1);
    expect(good.srs.due).toBeGreaterThan(again.srs.due);
    expect(again.srs.due - T0).toBeLessThanOrEqual(10 * MIN);
  });
});

describe('buildQueue', () => {
  it('puts the most overdue cards first, then new cards, within the allowance and limit', () => {
    const cards = [
      card('new1', { createdAt: T0 + 1 }),
      reviewed('slightly', -1 * DAY, 10), // 10% overdue
      reviewed('very', -2 * DAY, 1), // 200% overdue
      reviewed('future', +DAY),
      card('new2', { createdAt: T0 + 2 }),
      card('draft', { status: 'draft' }),
    ];
    expect(buildQueue(cards, { now: T0, newAllowance: 1 }).map((c) => c.id)).toEqual(['very', 'slightly', 'new1']);
    expect(buildQueue(cards, { now: T0, newAllowance: 5, limit: 3 }).map((c) => c.id)).toEqual(['very', 'slightly', 'new1']);
    expect(buildQueue(cards, { now: T0, newAllowance: 5 }).map((c) => c.id)).toEqual(['very', 'slightly', 'new1', 'new2']);
  });
});

describe('deckStats', () => {
  it('counts due, new and the next due time over active cards only', () => {
    const st = deckStats([reviewed('d', -MIN), reviewed('f', 2 * DAY), card('n'), card('x', { status: 'draft' })], T0);
    expect(st).toMatchObject({ total: 3, due: 1, newCards: 1, nextDueAt: T0 + 2 * DAY });
  });
});

describe('secondsPerCard', () => {
  const log = (ms: number): ReviewLogEntry => ({ id: String(ms), cardId: 'c', at: T0, rating: 'good', durationMs: ms, sessionId: 's' });

  it('falls back with too little history', () => {
    expect(secondsPerCard([log(5000)], 10)).toBe(10);
  });

  it('uses the median and ignores outliers', () => {
    const logs = [4000, 5000, 5000, 6000, 6000, 7000, 8000, 9000, 600_000, 200].map(log);
    expect(secondsPerCard(logs, 10)).toBe(6);
  });
});

describe('ReviewSession', () => {
  it('requires a reveal before grading and logs durations', () => {
    let now = T0;
    const s = new ReviewSession([card('a'), card('b')], { id: 's1', secondsPerCard: 5, now: () => now });
    expect(s.answer('good')).toBeUndefined();
    now += 4000;
    s.reveal();
    const res = s.answer('good');
    expect(res?.log).toMatchObject({ cardId: 'a', rating: 'good', durationMs: 4000, sessionId: 's1' });
    expect(s.current?.id).toBe('b');
    expect(s.position).toBe(2);
  });

  it('brings a missed card back once, later in the round', () => {
    const s = new ReviewSession(['a', 'b', 'c', 'd', 'e', 'f'].map((id) => card(id)), { id: 's', secondsPerCard: 5 });
    s.reveal();
    s.answer('again');
    const order: string[] = [];
    while (s.current) {
      order.push(s.current.id);
      s.reveal();
      s.answer('good');
    }
    expect(order).toEqual(['b', 'c', 'd', 'a', 'e', 'f']);
    expect(s.result()).toMatchObject({ reviewed: 7, good: 6, again: 1, endedBy: 'done', leftInQueue: 0 });
  });

  it('stops a commute round before a card that would not fit before arrival', () => {
    let now = T0;
    const endsAt = T0 + 30_000; // 30 s left, 10 s per card
    const s = new ReviewSession(['a', 'b', 'c', 'd', 'e'].map((id) => card(id)), { id: 's', secondsPerCard: 10, endsAt, now: () => now });
    let shown = 0;
    while (s.current) {
      shown++;
      s.reveal();
      now += 10_000;
      s.answer('good');
    }
    // Cards end at +10, +20, +30 s; a fourth would end at +40 s, past the stop time.
    expect(shown).toBe(3);
    expect(s.result()).toMatchObject({ endedBy: 'time', leftInQueue: 2 });
    expect(s.minutesLeft()).toBe(0);
  });

  it('lets you finish the card on screen even if time runs out mid-card', () => {
    let now = T0;
    const s = new ReviewSession([card('a'), card('b')], { id: 's', secondsPerCard: 10, endsAt: T0 + 15_000, now: () => now });
    s.reveal();
    now += 20_000; // past the end, but the answer is visible
    expect(s.current?.id).toBe('a');
    expect(s.answer('good')).toBeDefined();
    expect(s.isOver).toBe(true);
  });
});
