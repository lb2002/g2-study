import { BACK_MAX, FRONT_MAX, type DraftCard } from '../types';

/**
 * Card generation pipeline, independent of the model backend:
 *   transcript -> chunks -> backend(chunk) -> parse -> clean -> dedupe
 */
export interface CardBackend {
  readonly name: string;
  generate(chunk: string, ctx: { chunkIndex: number; chunkCount: number; targetCards: number }): Promise<DraftCard[]>;
}

export interface GenerateOptions {
  maxChunkChars?: number;
  /** Existing cards to dedupe against (e.g. the rest of the deck). */
  existing?: Pick<DraftCard, 'front'>[];
  onProgress?: (done: number, total: number) => void;
  signal?: AbortSignal;
}

export async function generateCards(transcript: string, backend: CardBackend, opts: GenerateOptions = {}): Promise<DraftCard[]> {
  const chunks = chunkTranscript(transcript, opts.maxChunkChars ?? 6000);
  const collected: DraftCard[] = [];
  opts.onProgress?.(0, chunks.length);
  for (let i = 0; i < chunks.length; i++) {
    if (opts.signal?.aborted) throw new DOMException('Aborted', 'AbortError');
    const words = chunks[i].split(/\s+/).length;
    const targetCards = Math.max(3, Math.min(12, Math.round(words / 120)));
    const cards = await backend.generate(chunks[i], { chunkIndex: i, chunkCount: chunks.length, targetCards });
    collected.push(...cards.map(cleanCard).filter((c): c is DraftCard => c !== null));
    opts.onProgress?.(i + 1, chunks.length);
  }
  return dedupeCards(collected, opts.existing ?? []);
}

/** Split on paragraph, then sentence boundaries so no chunk exceeds maxChars. */
export function chunkTranscript(text: string, maxChars: number): string[] {
  const clean = text.replace(/\r\n/g, '\n').trim();
  if (!clean) return [];
  if (clean.length <= maxChars) return [clean];
  const sentences = clean.split(/(?<=[.!?])\s+|\n{2,}/).filter(Boolean);
  const chunks: string[] = [];
  let cur = '';
  for (const s of sentences) {
    if (s.length > maxChars) {
      if (cur) chunks.push(cur.trim());
      cur = '';
      for (let i = 0; i < s.length; i += maxChars) chunks.push(s.slice(i, i + maxChars));
      continue;
    }
    if (cur.length + s.length + 1 > maxChars) {
      chunks.push(cur.trim());
      cur = '';
    }
    cur += s + ' ';
  }
  if (cur.trim()) chunks.push(cur.trim());
  return chunks;
}

/**
 * Parse model output. Accepts a bare array, {"cards": [...]}, or either one
 * wrapped in a markdown code fence or surrounded by chatter.
 */
export function parseCardJson(raw: string): DraftCard[] {
  const text = raw.trim().replace(/^```(?:json)?\s*/i, '').replace(/\s*```$/, '');
  const candidates = [text];
  const arr = text.match(/\[[\s\S]*\]/);
  const obj = text.match(/\{[\s\S]*\}/);
  if (obj) candidates.push(obj[0]);
  if (arr) candidates.push(arr[0]);
  for (const c of candidates) {
    try {
      const parsed = JSON.parse(c);
      const list = Array.isArray(parsed) ? parsed : Array.isArray(parsed?.cards) ? parsed.cards : null;
      if (!list) continue;
      return list
        .filter((x: unknown): x is Record<string, unknown> => !!x && typeof x === 'object')
        .map((x: Record<string, unknown>) => ({
          front: String(x.front ?? x.question ?? ''),
          back: String(x.back ?? x.answer ?? ''),
          sourceSnippet: String(x.source_snippet ?? x.sourceSnippet ?? x.source ?? ''),
        }));
    } catch {
      /* try the next candidate */
    }
  }
  throw new Error('Model did not return card JSON');
}

/** Normalise whitespace, drop empties, and replace glyphs the G2 font may not have. */
export function cleanCard(c: DraftCard): DraftCard | null {
  const tidy = (s: string) => toDisplaySafe(s.replace(/\s+/g, ' ').trim());
  const front = tidy(c.front);
  const back = tidy(c.back);
  if (front.length < 3 || back.length < 1) return null;
  return { front, back, sourceSnippet: c.sourceSnippet.replace(/\s+/g, ' ').trim().slice(0, 300) };
}

const GLYPH_MAP: Record<string, string> = {
  '‘': "'", '’': "'", '“': '"', '”': '"', '–': '-', '—': '-',
  '…': '...', ' ': ' ', '→': '->', '←': '<-', '≤': '<=', '≥': '>=',
  '≠': '!=', '×': 'x', '•': '-',
};

export function toDisplaySafe(s: string): string {
  return s.replace(/[‘’“”–—… ←→≤≥≠×•]/g, (ch) => GLYPH_MAP[ch] ?? ch);
}

export function isOverLimit(c: Pick<DraftCard, 'front' | 'back'>): boolean {
  return c.front.length > FRONT_MAX || c.back.length > BACK_MAX;
}

const STOPWORDS = new Set(
  'a an the of to in on for and or is are was were be what which who how why when does do did it its this that with by from as at into than then define explain describe name main purpose'.split(' '),
);

function keyTokens(s: string): Set<string> {
  return new Set(
    s
      .toLowerCase()
      .replace(/[^\p{L}\p{N}\s]/gu, ' ')
      .split(/\s+/)
      .filter((w) => w.length > 1 && !STOPWORDS.has(w)),
  );
}

export function similarity(a: string, b: string): number {
  const ta = keyTokens(a);
  const tb = keyTokens(b);
  if (ta.size === 0 || tb.size === 0) return a.trim().toLowerCase() === b.trim().toLowerCase() ? 1 : 0;
  let inter = 0;
  ta.forEach((t) => tb.has(t) && inter++);
  return inter / (ta.size + tb.size - inter);
}

/** Drop near-duplicate fronts (token Jaccard >= threshold), keeping the first. */
export function dedupeCards(cards: DraftCard[], existing: Pick<DraftCard, 'front'>[] = [], threshold = 0.6): DraftCard[] {
  const kept: DraftCard[] = [];
  const seen = existing.map((e) => e.front);
  for (const c of cards) {
    if (seen.some((f) => similarity(f, c.front) >= threshold)) continue;
    kept.push(c);
    seen.push(c.front);
  }
  return kept;
}

export function buildCardPrompt(chunk: string, ctx: { chunkIndex: number; chunkCount: number; targetCards: number; language?: string }) {
  const lang = ctx.language ? `Write the cards in ${ctx.language}.` : 'Write the cards in the language of the transcript.';
  const system = [
    'You turn university lecture transcripts into spaced-repetition flashcards for smart glasses with a tiny monochrome display.',
    'Rules:',
    `- "front": a question or cue, at most ${FRONT_MAX} characters.`,
    `- "back": the answer, at most ${BACK_MAX} characters. No lists, no markdown.`,
    '- "source_snippet": a short verbatim quote (max 200 chars) from the transcript that supports the card.',
    '- One fact per card. Prefer definitions, causes, contrasts, numbers and named results the lecturer stressed.',
    '- Skip organisational talk (exam dates, breaks, jokes) and anything the transcript does not actually say.',
    '- Transcripts come from speech recognition: silently fix obvious mis-hearings of technical terms.',
    '- Use plain ASCII punctuation. No emoji.',
    lang,
    'Return only JSON: {"cards":[{"front":"...","back":"...","source_snippet":"..."}]}',
  ].join('\n');
  const user = `Transcript part ${ctx.chunkIndex + 1} of ${ctx.chunkCount}. Make about ${ctx.targetCards} cards.\n\n"""\n${chunk}\n"""`;
  return { system, user };
}
