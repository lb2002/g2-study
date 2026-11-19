import type { Connection } from './transport';

export interface CommutePlan {
  connection?: Connection;
  /** When the round should end (arrival minus buffer), epoch ms. */
  endsAt: number;
  /** Minutes available for reviewing, from session start. */
  studyMinutes: number;
  rideMinutes: number;
  secondsPerCard: number;
  /** Cards that fit, before looking at what is due. */
  capacity: number;
}

/**
 * Size a round to a ride. If we are already on the train (departure in the
 * past), the budget runs from now; if the train has not left yet, it runs from
 * departure, because nobody reviews while running for the platform.
 */
export function planCommute(opts: {
  connection?: Connection;
  /** Used when there is no connection (offline / manual mode). */
  manualMinutes?: number;
  bufferMin: number;
  secondsPerCard: number;
  now?: number;
}): CommutePlan {
  const now = opts.now ?? Date.now();
  const spc = Math.max(1, opts.secondsPerCard);
  if (opts.connection) {
    const c = opts.connection;
    const start = Math.max(now, c.departure);
    const endsAt = c.arrival - opts.bufferMin * 60_000;
    const studyMs = Math.max(0, endsAt - start);
    return {
      connection: c,
      endsAt,
      studyMinutes: Math.round(studyMs / 60_000),
      rideMinutes: Math.round((c.arrival - c.departure) / 60_000),
      secondsPerCard: spc,
      capacity: Math.floor(studyMs / 1000 / spc),
    };
  }
  const minutes = Math.max(0, (opts.manualMinutes ?? 0) - opts.bufferMin);
  return {
    endsAt: now + minutes * 60_000,
    studyMinutes: minutes,
    rideMinutes: opts.manualMinutes ?? 0,
    secondsPerCard: spc,
    capacity: Math.floor((minutes * 60) / spc),
  };
}

/** Should we stop before showing another card? Keeps one average card of slack. */
export function shouldStop(now: number, endsAt: number, secondsPerCard: number): boolean {
  return now + secondsPerCard * 1000 > endsAt;
}

export function formatClock(ms: number): string {
  const d = new Date(ms);
  return `${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}`;
}
