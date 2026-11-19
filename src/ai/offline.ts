import { BACK_MAX, FRONT_MAX, type DraftCard } from '../types';
import type { CardBackend } from './cards';

/**
 * Rule-based card extractor. No network, no key: it looks for definition-style
 * sentences ("X is ...", "X refers to ...", "... is called X"). Much weaker than
 * an LLM, but it lets the whole flow run in the simulator with zero setup.
 */
export class OfflineBackend implements CardBackend {
  readonly name = 'offline rule-based extractor';

  async generate(chunk: string, ctx: { targetCards: number }): Promise<DraftCard[]> {
    return extractDefinitions(chunk).slice(0, Math.max(ctx.targetCards, 3) * 2);
  }
}

const BAD_SUBJECT = /^(it|this|that|these|those|there|here|we|you|i|he|she|they|which|what|so|and|but|or|then|now|today|one|the idea|the point|the reason|the question|my|our|your)\b/i;
const FILLER = /^(so|okay|ok|now|right|alright|well|and|basically|actually|remember|note that|recall that)[,\s]+/i;

export function extractDefinitions(text: string): DraftCard[] {
  const sentences = text
    .replace(/\s+/g, ' ')
    .split(/(?<=[.!?])\s+/)
    .map((s) => s.trim())
    .filter((s) => s.length > 20 && s.length < 400);
  const out: DraftCard[] = [];
  for (const raw of sentences) {
    let s = raw;
    while (FILLER.test(s)) s = s.replace(FILLER, '');
    const card = matchCalled(s, text) ?? matchRefersTo(s, text) ?? matchIs(s, text);
    if (card) out.push({ ...card, sourceSnippet: raw.slice(0, 200) });
  }
  return out;
}

const VAGUE = /^(classic|main|first|second|third|next|last|other|same|big|important|key|real|basic|simple|whole|only|best|usual|standard|good|bad|new|old)\b/i;

function matchIs(s: string, text: string): Omit<DraftCard, 'sourceSnippet'> | null {
  const m = s.match(/^((?:an?|the)\s+)?([A-Za-z][\w\-'/ ]{1,48}?)\s+(is|are)\s+((?:a|an|the|when|how|what|basically)\b.+)$/i);
  if (!m) return null;
  const subject = m[2].trim();
  if (!isGoodSubject(subject)) return null;
  const verb = m[3].toLowerCase();
  const answer = stripTrailing(m[4]).replace(/^basically\s+/i, '');
  return build(`What ${verb} ${withArticle(m[1], subject, text)}?`, answer);
}

function matchRefersTo(s: string, text: string): Omit<DraftCard, 'sourceSnippet'> | null {
  const m = s.match(/^((?:an?|the)\s+)?([A-Za-z][\w\-'/ ]{1,48}?)\s+(refers to|means|describes|stands for|denotes)\s+(.+)$/i);
  if (!m || !isGoodSubject(m[2].trim())) return null;
  const base: Record<string, string> = {
    'refers to': 'refer to',
    means: 'mean',
    describes: 'describe',
    'stands for': 'stand for',
    denotes: 'denote',
  };
  return build(`What does ${withArticle(m[1], m[2].trim(), text)} ${base[m[3].toLowerCase()]}?`, stripTrailing(m[4]));
}

function matchCalled(s: string, text: string): Omit<DraftCard, 'sourceSnippet'> | null {
  const m = s.match(/^(.{15,160}?)\s+(?:is|are)\s+(?:called|known as|referred to as)\s+(an?\s+|the\s+)?([A-Za-z][\w\-' ]{1,40}?)[.!?]?$/i);
  if (!m || !isGoodSubject(m[3].trim())) return null;
  return build(`What is ${withArticle(m[2], m[3].trim(), text)}?`, stripTrailing(m[1]));
}

function isGoodSubject(subject: string): boolean {
  const words = subject.split(/\s+/);
  return words.length <= 6 && !BAD_SUBJECT.test(subject) && !VAGUE.test(subject) && /[a-z]/i.test(subject);
}

/**
 * Sentence-initial capitals are not part of the term: "Padding is..." -> "padding".
 * Keep acronyms, names with digits, and words the text also capitalises mid-sentence (Diffie-Hellman).
 */
function withArticle(article: string | undefined, subject: string, text: string): string {
  const first = subject.split(/\s+/)[0];
  const keepCase =
    /[A-Z0-9]/.test(first.slice(1)) ||
    new RegExp(`[^.!?\\s]\\s+${first.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}\\b`).test(text);
  const term = keepCase ? subject : subject.charAt(0).toLowerCase() + subject.slice(1);
  return article ? `${article.trim().toLowerCase()} ${term}` : term;
}

function stripTrailing(s: string): string {
  return s.replace(/[.!?]+$/, '').trim();
}

function build(front: string, back: string): Omit<DraftCard, 'sourceSnippet'> | null {
  let b = back.charAt(0).toUpperCase() + back.slice(1);
  if (b.length > BACK_MAX) {
    // Cut at the last clause boundary that fits, else at a word boundary.
    const cut = b.slice(0, BACK_MAX);
    const clause = Math.max(cut.lastIndexOf(', '), cut.lastIndexOf('; '), cut.lastIndexOf(': '), cut.lastIndexOf(' - '));
    b = clause > 40 ? cut.slice(0, clause) : cut.slice(0, cut.slice(0, BACK_MAX - 3).lastIndexOf(' ')) + '...';
  }
  if (front.length > FRONT_MAX || b.length < 8) return null;
  return { front, back: b };
}
