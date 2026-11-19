import { readFileSync } from 'node:fs';
import { describe, expect, it, vi } from 'vitest';
import { chunkTranscript, cleanCard, dedupeCards, generateCards, parseCardJson, similarity, type CardBackend } from '../src/ai/cards';
import { extractDefinitions, OfflineBackend } from '../src/ai/offline';
import { OpenAICompatBackend } from '../src/ai/openai';
import { BACK_MAX, FRONT_MAX } from '../src/types';

const sample = readFileSync(new URL('../samples/public-key-crypto.txt', import.meta.url), 'utf8');

describe('parseCardJson', () => {
  const card = { front: 'What is a nonce?', back: 'A number used once.', source_snippet: 'a nonce is a number used once' };

  it('accepts {"cards": [...]}', () => {
    expect(parseCardJson(JSON.stringify({ cards: [card] }))).toEqual([{ front: card.front, back: card.back, sourceSnippet: card.source_snippet }]);
  });

  it('accepts a bare array inside a code fence', () => {
    expect(parseCardJson('```json\n' + JSON.stringify([card]) + '\n```')).toHaveLength(1);
  });

  it('accepts JSON surrounded by chatter and question/answer keys', () => {
    const out = parseCardJson('Sure! Here you go:\n[{"question":"Q?","answer":"A"}]\nHope this helps.');
    expect(out[0]).toEqual({ front: 'Q?', back: 'A', sourceSnippet: '' });
  });

  it('throws on non-JSON', () => {
    expect(() => parseCardJson('I cannot do that.')).toThrow();
  });
});

describe('cleanCard', () => {
  it('normalises whitespace and swaps glyphs the font lacks', () => {
    expect(cleanCard({ front: '  What’s  RSA? ', back: 'A “public-key” system…', sourceSnippet: '' })).toEqual({
      front: "What's RSA?",
      back: 'A "public-key" system...',
      sourceSnippet: '',
    });
  });

  it('drops empty cards', () => {
    expect(cleanCard({ front: '', back: 'x', sourceSnippet: '' })).toBeNull();
  });
});

describe('dedupeCards', () => {
  it('drops near-duplicate fronts, keeping the first', () => {
    const cards = [
      { front: 'What is the discrete logarithm problem?', back: 'a', sourceSnippet: '' },
      { front: 'Define the discrete logarithm problem', back: 'b', sourceSnippet: '' },
      { front: 'What is forward secrecy?', back: 'c', sourceSnippet: '' },
    ];
    expect(dedupeCards(cards).map((c) => c.back)).toEqual(['a', 'c']);
  });

  it('dedupes against existing deck cards', () => {
    const out = dedupeCards([{ front: 'What is forward secrecy?', back: 'x', sourceSnippet: '' }], [{ front: 'what is forward secrecy' }]);
    expect(out).toHaveLength(0);
  });

  it('keeps distinct questions about the same topic', () => {
    expect(similarity('What key size does RSA need today?', 'Which exponent e does RSA usually use?')).toBeLessThan(0.6);
  });
});

describe('chunkTranscript', () => {
  it('keeps short text whole and splits long text on sentences', () => {
    expect(chunkTranscript('One. Two.', 100)).toEqual(['One. Two.']);
    const chunks = chunkTranscript(sample, 1500);
    expect(chunks.length).toBeGreaterThan(3);
    chunks.forEach((c) => expect(c.length).toBeLessThanOrEqual(1500));
    expect(chunks.join(' ').replace(/\s+/g, ' ').length).toBeGreaterThan(sample.replace(/\s+/g, ' ').length * 0.98);
  });
});

describe('generateCards', () => {
  it('runs every chunk, cleans and dedupes, and reports progress', async () => {
    const backend: CardBackend = {
      name: 'fake',
      generate: vi.fn(async (_chunk: string, ctx: { chunkIndex: number }) => [
        { front: 'What is PKI?', back: 'Public key infrastructure.', sourceSnippet: '' },
        { front: `Chunk ${ctx.chunkIndex} fact?`, back: 'Yes.', sourceSnippet: '' },
      ]),
    };
    const progress: number[] = [];
    const out = await generateCards(sample, backend, { maxChunkChars: 2500, onProgress: (d) => progress.push(d) });
    const calls = (backend.generate as ReturnType<typeof vi.fn>).mock.calls.length;
    expect(calls).toBeGreaterThan(1);
    expect(out.filter((c) => c.front === 'What is PKI?')).toHaveLength(1);
    expect(progress.at(-1)).toBe(calls);
  });
});

describe('offline extractor', () => {
  it('finds definition cards in the sample lecture that fit the display', async () => {
    const cards = await generateCards(sample, new OfflineBackend());
    expect(cards.length).toBeGreaterThanOrEqual(8);
    for (const c of cards) {
      expect(c.front.length).toBeLessThanOrEqual(FRONT_MAX);
      expect(c.back.length).toBeLessThanOrEqual(BACK_MAX);
    }
    const fronts = cards.map((c) => c.front);
    expect(fronts).toContain('What is a digital signature?');
    expect(fronts).toContain('What is forward secrecy?');
  });

  it('ignores sentences with pronoun subjects', () => {
    expect(extractDefinitions('It is a really important idea for the exam next week.')).toHaveLength(0);
  });
});

describe('OpenAICompatBackend', () => {
  it('posts a chat completion and parses the cards', async () => {
    const fetchMock = vi.fn(async (_url: string, init: RequestInit) => {
      const body = JSON.parse(String(init.body));
      expect(body.model).toBe('gpt-4o-mini');
      expect(body.response_format).toEqual({ type: 'json_object' });
      expect(body.messages[0].content).toContain('at most 60 characters');
      return new Response(JSON.stringify({ choices: [{ message: { content: '{"cards":[{"front":"F?","back":"B","source_snippet":"s"}]}' } }] }), { status: 200 });
    });
    const b = new OpenAICompatBackend({ baseUrl: 'https://api.openai.com/v1/', model: 'gpt-4o-mini', apiKey: 'sk-test' }, fetchMock as unknown as typeof fetch);
    const out = await b.generate('text', { chunkIndex: 0, chunkCount: 1, targetCards: 3 });
    expect(out).toEqual([{ front: 'F?', back: 'B', sourceSnippet: 's' }]);
    expect(fetchMock.mock.calls[0][0]).toBe('https://api.openai.com/v1/chat/completions');
    expect((fetchMock.mock.calls[0][1].headers as Record<string, string>).Authorization).toBe('Bearer sk-test');
  });

  it('retries without response_format when a local server rejects it', async () => {
    let n = 0;
    const fetchMock = vi.fn(async (_url: string, init: RequestInit) => {
      n++;
      const body = JSON.parse(String(init.body));
      if (body.response_format) return new Response('{"error":{"message":"unsupported"}}', { status: 400 });
      return new Response(JSON.stringify({ choices: [{ message: { content: '[{"front":"F?","back":"B"}]' } }] }), { status: 200 });
    });
    const b = new OpenAICompatBackend({ baseUrl: 'http://localhost:11434/v1', model: 'llama3.1', apiKey: '' }, fetchMock as unknown as typeof fetch);
    expect(await b.generate('t', { chunkIndex: 0, chunkCount: 1, targetCards: 1 })).toHaveLength(1);
    expect(n).toBe(2);
  });

  it('surfaces API errors', async () => {
    const fetchMock = vi.fn(async () => new Response('{"error":{"message":"Incorrect API key"}}', { status: 401 }));
    const b = new OpenAICompatBackend({ baseUrl: 'https://api.openai.com/v1', model: 'm', apiKey: 'bad' }, fetchMock as unknown as typeof fetch);
    await expect(b.generate('t', { chunkIndex: 0, chunkCount: 1, targetCards: 1 })).rejects.toThrow(/401 Incorrect API key/);
  });
});
