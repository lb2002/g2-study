/**
 * transport.opendata.ch: free Swiss public transport API, no key, CORS enabled.
 * https://transport.opendata.ch/docs.html
 */
export interface Connection {
  from: string;
  to: string;
  departure: number; // epoch ms, including known delay
  arrival: number; // epoch ms, including known delay
  plannedDeparture: number;
  plannedArrival: number;
  delayMin: number;
  platform?: string;
  /** e.g. "S12", "IC 5". */
  products: string[];
  transfers: number;
}

const API = 'https://transport.opendata.ch/v1/connections';

export async function fetchConnections(
  from: string,
  to: string,
  opts: { limit?: number; fetchImpl?: typeof fetch; signal?: AbortSignal } = {},
): Promise<Connection[]> {
  const url = `${API}?${new URLSearchParams({ from, to, limit: String(opts.limit ?? 4) })}`;
  const doFetch = opts.fetchImpl ?? ((...a: Parameters<typeof fetch>) => fetch(...a));
  const res = await doFetch(url, { signal: opts.signal });
  if (!res.ok) throw new Error(`Timetable request failed (${res.status})`);
  return parseConnections(await res.json());
}

export function parseConnections(json: unknown): Connection[] {
  const list = (json as { connections?: unknown[] })?.connections;
  if (!Array.isArray(list)) return [];
  const out: Connection[] = [];
  for (const raw of list) {
    const c = raw as Record<string, any>;
    const plannedDeparture = toMs(c?.from?.departureTimestamp, c?.from?.departure);
    const plannedArrival = toMs(c?.to?.arrivalTimestamp, c?.to?.arrival);
    if (!plannedDeparture || !plannedArrival) continue;
    const depPrognosis = toMs(undefined, c?.from?.prognosis?.departure);
    const arrPrognosis = toMs(undefined, c?.to?.prognosis?.arrival);
    const delayMin = Number(c?.from?.delay) || 0;
    out.push({
      from: c?.from?.station?.name ?? '',
      to: c?.to?.station?.name ?? '',
      plannedDeparture,
      plannedArrival,
      departure: depPrognosis ?? plannedDeparture + delayMin * 60_000,
      arrival: arrPrognosis ?? plannedArrival + (Number(c?.to?.delay) || 0) * 60_000,
      delayMin,
      platform: c?.from?.prognosis?.platform ?? c?.from?.platform ?? undefined,
      products: Array.isArray(c?.products) ? c.products.map(String) : [],
      transfers: Number(c?.transfers) || 0,
    });
  }
  return out;
}

function toMs(ts: unknown, iso: unknown): number | undefined {
  if (typeof ts === 'number' && ts > 0) return ts * 1000;
  if (typeof iso === 'string' && iso) {
    const t = Date.parse(iso.replace(/([+-]\d{2})(\d{2})$/, '$1:$2'));
    return Number.isNaN(t) ? undefined : t;
  }
  return undefined;
}

/** Pick the next connection we can still catch (departing now or later). */
export function nextCatchable(conns: Connection[], now = Date.now(), graceMs = 60_000): Connection | undefined {
  return conns.filter((c) => c.departure >= now - graceMs).sort((a, b) => a.departure - b.departure)[0];
}
