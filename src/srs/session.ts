import type { ReviewLogEntry, StudyCard } from '../types';
import { grade, type Verdict } from './scheduler';

export interface SessionOptions {
  id: string;
  /** Commute rounds end at a wall-clock time; plain rounds end when the queue is empty. */
  endsAt?: number;
  /** Real (wall-clock) seconds the user needs per card. */
  secondsPerCard: number;
  /** Clock, injectable so the demo can run a 20 min ride in one minute and tests can control time. */
  now?: () => number;
  /** How much faster `now` runs than real time (demo clock). Durations are reported in real time. */
  timeScale?: number;
}

export interface SessionResult {
  reviewed: number;
  good: number;
  again: number;
  avgSeconds: number;
  endedBy: 'done' | 'time' | 'user';
  leftInQueue: number;
}

/**
 * One review round. Holds the queue, the card on screen and timing; persistence
 * is the caller's job (it gets back the graded card and a log entry).
 */
export class ReviewSession {
  readonly id: string;
  private queue: StudyCard[];
  private pos = 0;
  private shownAt = 0;
  private revealed = false;
  private stats = { good: 0, again: 0, ms: 0 };
  private requeued = new Set<string>();
  private ended?: SessionResult['endedBy'];
  readonly total: number;
  readonly endsAt?: number;
  private readonly spc: number;
  private readonly scale: number;
  private readonly now: () => number;

  constructor(cards: StudyCard[], opts: SessionOptions) {
    this.id = opts.id;
    this.queue = [...cards];
    this.total = cards.length;
    this.endsAt = opts.endsAt;
    this.spc = opts.secondsPerCard;
    this.scale = Math.max(1, opts.timeScale ?? 1);
    this.now = opts.now ?? Date.now;
    this.shownAt = this.now();
  }

  get current(): StudyCard | undefined {
    return this.isOver ? undefined : this.queue[this.pos];
  }

  get isRevealed(): boolean {
    return this.revealed;
  }

  /** 1-based position for "3 / 15" style headers. */
  get position(): number {
    return Math.min(this.pos + 1, this.queue.length);
  }

  get length(): number {
    return this.queue.length;
  }

  get isOver(): boolean {
    if (this.ended) return true;
    if (this.pos >= this.queue.length) return true;
    // Do not start a card we cannot finish before the stop time.
    if (this.endsAt !== undefined && !this.revealed && this.now() + this.spc * 1000 * this.scale > this.endsAt) return true;
    return false;
  }

  /** Minutes until the round must end (commute only). */
  minutesLeft(): number | undefined {
    return this.endsAt === undefined ? undefined : Math.max(0, Math.ceil((this.endsAt - this.now()) / 60_000));
  }

  reveal(): void {
    if (this.current) this.revealed = true;
  }

  answer(verdict: Verdict): { card: StudyCard; log: Omit<ReviewLogEntry, 'id'> } | undefined {
    const card = this.current;
    if (!card || !this.revealed) return undefined;
    const at = this.now();
    const durationMs = Math.round((at - this.shownAt) / this.scale);
    const graded = grade(card, verdict, new Date(at));
    this.queue[this.pos] = graded;
    this.stats[verdict]++;
    this.stats.ms += durationMs;
    // Missed cards come back later in the same round (once), FSRS gives them a short step anyway.
    if (verdict === 'again' && !this.requeued.has(card.id)) {
      this.requeued.add(card.id);
      const insertAt = Math.min(this.queue.length, this.pos + 4);
      this.queue.splice(insertAt, 0, graded);
    }
    this.pos++;
    this.revealed = false;
    this.shownAt = at;
    return { card: graded, log: { cardId: card.id, at, rating: verdict, durationMs, sessionId: this.id } };
  }

  stop(): void {
    this.ended = 'user';
  }

  result(): SessionResult {
    const reviewed = this.stats.good + this.stats.again;
    let endedBy: SessionResult['endedBy'] = this.ended ?? 'done';
    if (!this.ended && this.pos < this.queue.length) endedBy = 'time';
    return {
      reviewed,
      good: this.stats.good,
      again: this.stats.again,
      avgSeconds: reviewed ? Math.round(this.stats.ms / reviewed / 100) / 10 : 0,
      endedBy,
      leftInQueue: Math.max(0, this.queue.length - this.pos),
    };
  }
}
