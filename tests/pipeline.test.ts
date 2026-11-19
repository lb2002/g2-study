import 'fake-indexeddb/auto';
import { describe, expect, it, vi } from 'vitest';
import type { Transcriber } from '../src/ai/transcribe';
import { WhisperHttpTranscriber } from '../src/ai/transcribe';
import { TranscriptionQueue } from '../src/audio/transcription-queue';
import { Store, uid } from '../src/storage/db';

async function freshStore() {
  return Store.open(uid('test-'));
}

async function addLecture(store: Store) {
  const id = uid('l');
  await store.putLecture({ id, title: 't', createdAt: Date.now(), source: 'glasses-mic', state: 'recording', transcript: '', durationMs: 0 });
  return id;
}

const pcm = (n: number) => new Uint8Array(3200 * n);

describe('TranscriptionQueue', () => {
  it('transcribes chunks in order, passes the previous text as prompt and drops the audio', async () => {
    const store = await freshStore();
    const lectureId = await addLecture(store);
    const prompts: (string | undefined)[] = [];
    const t: Transcriber = {
      name: 'fake',
      transcribe: vi.fn(async (_wav: Blob, o: { prompt?: string }) => {
        prompts.push(o.prompt);
        return `part${prompts.length}`;
      }),
    };
    const q = new TranscriptionQueue(store, () => t, () => {});
    await q.add(lectureId, 0, pcm(10), 1000);
    await q.add(lectureId, 1, pcm(10), 1000);
    await q.add(lectureId, 2, pcm(10), 1000);
    expect(await q.drain(lectureId)).toEqual({ pending: 0, failed: 0 });
    expect((await store.getLecture(lectureId))?.transcript).toBe('part1 part2 part3');
    expect(prompts).toEqual(['', 'part1', 'part1 part2']);
    const chunks = await store.listChunks(lectureId);
    expect(chunks.every((c) => c.wav === undefined && c.text)).toBe(true);
  });

  it('retries failures and keeps the audio when a chunk keeps failing', async () => {
    vi.useFakeTimers({ shouldAdvanceTime: true });
    const store = await freshStore();
    const lectureId = await addLecture(store);
    let calls = 0;
    const t: Transcriber = {
      name: 'flaky',
      transcribe: async () => {
        calls++;
        throw new Error('503 Service Unavailable');
      },
    };
    const q = new TranscriptionQueue(store, () => t, () => {});
    await q.add(lectureId, 0, pcm(5), 500);
    const drained = q.drain(lectureId);
    await vi.advanceTimersByTimeAsync(30_000);
    expect(await drained).toEqual({ pending: 0, failed: 1 });
    expect(calls).toBe(3);
    const [chunk] = await store.listChunks(lectureId);
    expect(chunk.wav).toBeDefined();
    expect(chunk.lastError).toContain('503');
    vi.useRealTimers();
  });

  it('waits without a transcriber and resumes on retry', async () => {
    const store = await freshStore();
    const lectureId = await addLecture(store);
    let transcriber: Transcriber | null = null;
    const q = new TranscriptionQueue(store, () => transcriber, () => {});
    await q.add(lectureId, 0, pcm(5), 500);
    expect(await q.drain(lectureId)).toEqual({ pending: 1, failed: 0 });
    transcriber = { name: 'ok', transcribe: async () => 'hello' };
    await q.retry(lectureId);
    await q.drain(lectureId);
    expect((await store.getLecture(lectureId))?.transcript).toBe('hello');
  });
});

describe('WhisperHttpTranscriber', () => {
  it('sends multipart audio with model, language and prompt', async () => {
    const fetchMock = vi.fn(async (url: string, init: RequestInit) => {
      expect(url).toBe('http://home:8000/v1/audio/transcriptions');
      const form = init.body as FormData;
      expect(form.get('model')).toBe('Systran/faster-whisper-small');
      expect(form.get('language')).toBe('de');
      expect(form.get('prompt')).toBe('previous words');
      expect((form.get('file') as File).name).toBe('chunk.wav');
      expect(init.headers).toEqual({});
      return new Response(JSON.stringify({ text: ' Hallo Welt ' }), { headers: { 'content-type': 'application/json' } });
    });
    const t = new WhisperHttpTranscriber({ baseUrl: 'http://home:8000/v1', model: 'Systran/faster-whisper-small', apiKey: '', language: 'de' }, fetchMock as unknown as typeof fetch);
    expect(await t.transcribe(new Blob([new Uint8Array(10)]), { prompt: 'previous words' })).toBe('Hallo Welt');
  });
});
