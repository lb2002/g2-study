import type { Transcriber } from '../ai/transcribe';
import type { Store } from '../storage/db';
import { uid } from '../storage/db';
import type { AudioChunk } from '../types';
import { encodeWav } from './pcm';

const MAX_ATTEMPTS = 3;
const BACKOFF_MS = [2_000, 6_000, 15_000];

/**
 * Persists every audio chunk before uploading it, transcribes chunks strictly
 * in order (each request gets the previous text as a prompt), retries with
 * backoff, and rebuilds the lecture transcript after each success. Audio is
 * deleted once its text is stored, so a dropped connection loses nothing.
 */
export class TranscriptionQueue {
  private running = new Map<string, Promise<void>>();
  private wake = new Map<string, () => void>();

  constructor(
    private store: Store,
    private getTranscriber: () => Transcriber | null,
    private onProgress: (lectureId: string) => void,
  ) {}

  async add(lectureId: string, index: number, pcm: Uint8Array, durationMs: number): Promise<void> {
    const wav = new Blob([encodeWav(pcm) as BlobPart], { type: 'audio/wav' });
    const chunk: AudioChunk = { id: uid('c'), lectureId, index, wav, durationMs, attempts: 0 };
    await this.store.putChunk(chunk);
    this.onProgress(lectureId);
    this.kick(lectureId);
  }

  /** Start (or nudge) the worker for a lecture. */
  kick(lectureId: string): void {
    const wake = this.wake.get(lectureId);
    if (wake) {
      wake();
      return;
    }
    if (this.running.has(lectureId)) return;
    const p = this.work(lectureId).finally(() => this.running.delete(lectureId));
    this.running.set(lectureId, p);
  }

  /** Resolves when every chunk is transcribed or has exhausted its retries. */
  async drain(lectureId: string): Promise<{ pending: number; failed: number }> {
    this.kick(lectureId);
    while (this.running.has(lectureId)) await this.running.get(lectureId);
    const chunks = await this.store.listChunks(lectureId);
    return {
      pending: chunks.filter((c) => c.text === undefined && c.attempts < MAX_ATTEMPTS).length,
      failed: chunks.filter((c) => c.text === undefined && c.attempts >= MAX_ATTEMPTS).length,
    };
  }

  /** Give failed chunks a fresh set of attempts (after fixing settings, or back online). */
  async retry(lectureId: string): Promise<void> {
    for (const c of await this.store.listChunks(lectureId)) {
      if (c.text === undefined) await this.store.putChunk({ ...c, attempts: 0, lastError: undefined });
    }
    this.kick(lectureId);
  }

  async counts(lectureId: string) {
    const chunks = await this.store.listChunks(lectureId);
    const done = chunks.filter((c) => c.text !== undefined);
    return {
      total: chunks.length,
      done: done.length,
      failed: chunks.filter((c) => c.text === undefined && c.attempts >= MAX_ATTEMPTS).length,
      lastError: [...chunks].reverse().find((c) => c.lastError)?.lastError,
      lastText: done.length ? done[done.length - 1].text ?? '' : '',
    };
  }

  private async work(lectureId: string): Promise<void> {
    for (;;) {
      const transcriber = this.getTranscriber();
      if (!transcriber) return;
      const chunks = await this.store.listChunks(lectureId);
      const next = chunks.find((c) => c.text === undefined && c.attempts < MAX_ATTEMPTS && c.wav);
      if (!next) return;
      const prompt = chunks
        .filter((c) => c.index < next.index && c.text)
        .map((c) => c.text)
        .join(' ');
      try {
        const text = await transcriber.transcribe(next.wav!, { prompt });
        await this.store.putChunk({ ...next, text, wav: undefined, lastError: undefined });
        await this.rebuildTranscript(lectureId);
      } catch (err) {
        const attempts = next.attempts + 1;
        await this.store.putChunk({ ...next, attempts, lastError: (err as Error).message });
        this.onProgress(lectureId);
        if (attempts < MAX_ATTEMPTS) await this.sleep(lectureId, BACKOFF_MS[attempts - 1]);
      }
      this.onProgress(lectureId);
    }
  }

  private sleep(lectureId: string, ms: number): Promise<void> {
    return new Promise<void>((resolve) => {
      const t = setTimeout(done, ms);
      function done() {
        clearTimeout(t);
        resolve();
      }
      this.wake.set(lectureId, () => {
        this.wake.delete(lectureId);
        done();
      });
    }).finally(() => this.wake.delete(lectureId));
  }

  private async rebuildTranscript(lectureId: string) {
    const chunks = await this.store.listChunks(lectureId);
    const transcript = chunks
      .filter((c) => c.text)
      .map((c) => c.text!.trim())
      .join(' ');
    await this.store.updateLecture(lectureId, { transcript });
  }
}
