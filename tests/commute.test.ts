import { readFileSync } from 'node:fs';
import { describe, expect, it, vi } from 'vitest';
import { planCommute, shouldStop } from '../src/commute/plan';
import { fetchConnections, nextCatchable, parseConnections, type Connection } from '../src/commute/transport';

const fixture = JSON.parse(readFileSync(new URL('./fixtures/connections-winterthur-zurich.json', import.meta.url), 'utf8'));
const MIN = 60_000;

describe('parseConnections', () => {
  it('parses a real transport.opendata.ch response', () => {
    const conns = parseConnections(fixture);
    expect(conns).toHaveLength(2);
    const c = conns[0];
    expect(c.from).toBe('Winterthur');
    expect(c.to).toBe('Zürich HB');
    expect(c.products).toEqual(['S12']);
    expect(c.departure).toBe(Date.parse('2026-11-19T19:22:00+01:00'));
    expect((c.arrival - c.departure) / MIN).toBe(20);
    expect(c.platform).toBe(fixture.connections[0].from.platform);
  });

  it('prefers the realtime prognosis when there is a delay', () => {
    const delayed = structuredClone(fixture);
    delayed.connections[0].from.delay = 3;
    delayed.connections[0].from.prognosis.departure = '2026-11-19T19:25:00+0100';
    delayed.connections[0].to.prognosis.arrival = '2026-11-19T19:45:00+0100';
    const c = parseConnections(delayed)[0];
    expect(c.delayMin).toBe(3);
    expect(c.departure - c.plannedDeparture).toBe(3 * MIN);
    expect(c.arrival - c.plannedArrival).toBe(3 * MIN);
  });

  it('returns [] for garbage', () => {
    expect(parseConnections(null)).toEqual([]);
    expect(parseConnections({ connections: [{}] })).toEqual([]);
  });
});

describe('fetchConnections', () => {
  it('builds the query and parses the response', async () => {
    const fetchMock = vi.fn(async (_url: string) => new Response(JSON.stringify(fixture)));
    const out = await fetchConnections('Winterthur', 'Zürich HB', { fetchImpl: fetchMock as unknown as typeof fetch });
    expect(out).toHaveLength(2);
    expect(String(fetchMock.mock.calls[0][0])).toBe('https://transport.opendata.ch/v1/connections?from=Winterthur&to=Z%C3%BCrich+HB&limit=4');
  });
});

describe('planCommute', () => {
  const dep = Date.parse('2026-11-19T19:22:00+01:00');
  const conn: Connection = { from: 'Winterthur', to: 'Zürich HB', departure: dep, arrival: dep + 20 * MIN, plannedDeparture: dep, plannedArrival: dep + 20 * MIN, delayMin: 0, products: ['S12'], transfers: 0 };

  it('budgets from departure to 2 min before arrival when the train has not left', () => {
    const p = planCommute({ connection: conn, bufferMin: 2, secondsPerCard: 10, now: dep - 5 * MIN });
    expect(p.rideMinutes).toBe(20);
    expect(p.studyMinutes).toBe(18);
    expect(p.capacity).toBe(108);
    expect(p.endsAt).toBe(dep + 18 * MIN);
  });

  it('budgets from now when already on the train', () => {
    const p = planCommute({ connection: conn, bufferMin: 2, secondsPerCard: 30, now: dep + 8 * MIN });
    expect(p.studyMinutes).toBe(10);
    expect(p.capacity).toBe(20);
  });

  it('has no budget once inside the buffer', () => {
    expect(planCommute({ connection: conn, bufferMin: 2, secondsPerCard: 10, now: dep + 19 * MIN }).capacity).toBe(0);
  });

  it('works without a connection (manual minutes)', () => {
    const p = planCommute({ manualMinutes: 20, bufferMin: 2, secondsPerCard: 9, now: 0 });
    expect(p).toMatchObject({ studyMinutes: 18, capacity: 120, endsAt: 18 * MIN });
  });

  it('shouldStop keeps one card of slack', () => {
    expect(shouldStop(0, 15_000, 10)).toBe(false);
    expect(shouldStop(6_000, 15_000, 10)).toBe(true);
  });
});

describe('nextCatchable', () => {
  it('skips trains that already left', () => {
    const mk = (d: number) => ({ departure: d }) as Connection;
    expect(nextCatchable([mk(5 * MIN), mk(-5 * MIN), mk(1 * MIN)], 0)?.departure).toBe(1 * MIN);
    expect(nextCatchable([mk(-5 * MIN)], 0)).toBeUndefined();
  });
});
