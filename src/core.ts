import { generateCards, type CardBackend } from './ai/cards';
import { OfflineBackend } from './ai/offline';
import { OpenAICompatBackend } from './ai/openai';
import { WhisperHttpTranscriber, type Transcriber } from './ai/transcribe';
import { decodeAudioFile } from './audio/decode';
import { PcmChunker } from './audio/pcm';
import { LectureRecorder, type RecorderStatus } from './audio/recorder';
import { TranscriptionQueue } from './audio/transcription-queue';
import { planCommute, type CommutePlan } from './commute/plan';
import { fetchConnections, nextCatchable } from './commute/transport';
import { Emitter, type GlassesHost } from './glasses/host';
import type { SettingsStore } from './settings';
import { buildQueue, deckStats, newCardsSeenToday, newSrs, secondsPerCard, type DeckStats, type Verdict } from './srs/scheduler';
import { ReviewSession } from './srs/session';
import { uid, type Store } from './storage/db';
import type { DraftCard, Lecture, LectureSource, StudyCard } from './types';

export interface LectureProgress {
  phase: 'recording' | 'transcribing' | 'generating';
  done: number;
  total: number;
}

export interface CommuteOffer {
  plan: CommutePlan;
  due: number;
  fresh: number;
  /** Cards the round will actually contain. */
  size: number;
  error?: string;
}

/**
 * Application core shared by the phone UI and the glasses controller. Owns the
 * pipelines (record -> transcribe -> cards, import -> cards) and review rounds.
 */
export class StudyApp {
  readonly changed = new Emitter<void>();
  readonly recorderStatus = new Emitter<RecorderStatus>();
  readonly progress = new Map<string, LectureProgress>();
  readonly recorder: LectureRecorder;
  private queue: TranscriptionQueue;
  private lastCommute?: CommuteOffer;
  /** Timetable answers are reused for a minute; card counts are always recomputed. */
  private connCache?: { key: string; at: number; conns: Awaited<ReturnType<typeof fetchConnections>> };

  constructor(
    readonly store: Store,
    readonly settings: SettingsStore,
    readonly host: GlassesHost,
  ) {
    this.queue = new TranscriptionQueue(store, () => this.transcriber(), (id) => void this.onTranscriptionProgress(id));
    this.recorder = new LectureRecorder(
      host,
      (lectureId, index, pcm, ms) => void this.queue.add(lectureId, index, pcm, ms),
      (s) => this.recorderStatus.emit(s),
    );
  }

  // --- backends ------------------------------------------------------------

  transcriber(): Transcriber | null {
    const t = this.settings.get().transcribe;
    if (t.provider === 'none' || !t.baseUrl) return null;
    if (!t.apiKey && /api\.openai\.com/.test(t.baseUrl)) return null;
    try {
      return new WhisperHttpTranscriber({ baseUrl: t.baseUrl, model: t.model, apiKey: t.apiKey, language: t.language || undefined });
    } catch {
      return null;
    }
  }

  cardBackend(): CardBackend {
    const c = this.settings.get().cards;
    if (c.provider === 'offline') return new OfflineBackend();
    return new OpenAICompatBackend({ baseUrl: c.baseUrl, model: c.model, apiKey: c.apiKey, language: c.language || undefined });
  }

  // --- deck ------------------------------------------------------------------

  async stats(): Promise<DeckStats> {
    return deckStats(await this.store.listCards());
  }

  async drafts(): Promise<StudyCard[]> {
    return (await this.store.listCards()).filter((c) => c.status === 'draft').sort((a, b) => a.createdAt - b.createdAt);
  }

  async saveCard(card: StudyCard) {
    await this.store.putCard(card);
    this.changed.emit();
  }

  async acceptCards(ids: string[]) {
    const all = await this.store.listCards();
    const now = Date.now();
    // Keep lecture order so new cards are introduced in the order they were taught.
    const updated = all
      .filter((c) => ids.includes(c.id))
      .sort((a, b) => a.createdAt - b.createdAt)
      .map((c, i) => ({ ...c, status: 'active' as const, createdAt: now + i }));
    await this.store.putCards(updated);
    this.changed.emit();
  }

  async deleteCard(id: string) {
    await this.store.deleteCard(id);
    this.changed.emit();
  }

  async deleteLecture(id: string) {
    await this.store.deleteLecture(id);
    this.progress.delete(id);
    this.changed.emit();
  }

  // --- capture pipelines -----------------------------------------------------

  async startRecording(): Promise<Lecture> {
    const s = this.settings.get();
    const source: LectureSource = this.host.kind === 'preview' ? 'browser-mic' : s.recording.mic === 'phone' ? 'phone-mic' : 'glasses-mic';
    const lecture = await this.newLecture(defaultTitle('Lecture'), source, 'recording');
    this.progress.set(lecture.id, { phase: 'recording', done: 0, total: 0 });
    try {
      await this.recorder.start(lecture.id, s.recording.mic, s.recording.chunkSeconds);
    } catch (err) {
      await this.store.updateLecture(lecture.id, { state: 'error', error: (err as Error).message });
      this.progress.delete(lecture.id);
      this.changed.emit();
      throw err;
    }
    this.changed.emit();
    return lecture;
  }

  async stopRecording(): Promise<string | undefined> {
    const res = await this.recorder.stop();
    if (!res) return undefined;
    await this.store.updateLecture(res.lectureId, { state: 'transcribing', durationMs: res.durationMs, diagnostics: res.diagnostics });
    this.changed.emit();
    void this.finishAudioLecture(res.lectureId);
    return res.lectureId;
  }

  /** Text, notes, a transcript or text copied from a PDF. */
  async importText(title: string, text: string, opts: { wait?: boolean } = {}): Promise<Lecture> {
    const lecture = await this.newLecture(title || defaultTitle('Notes'), 'text', 'generating', text.trim());
    const job = this.generateFor(lecture.id);
    if (opts.wait) await job;
    return lecture;
  }

  /** An audio file: decoded and resampled on the phone, then the same chunk pipeline as live audio. */
  async importAudio(file: File): Promise<Lecture> {
    const lecture = await this.newLecture(file.name.replace(/\.[^.]+$/, ''), 'audio-file', 'transcribing');
    this.progress.set(lecture.id, { phase: 'transcribing', done: 0, total: 0 });
    this.changed.emit();
    try {
      const pcm = await decodeAudioFile(file);
      const chunkSeconds = this.settings.get().recording.chunkSeconds;
      const pending: Promise<void>[] = [];
      const chunker = new PcmChunker({ targetSeconds: chunkSeconds }, (c) => pending.push(this.queue.add(lecture.id, c.index, c.pcm, c.durationMs)));
      for (let off = 0; off < pcm.length; off += 3200) chunker.push(pcm.subarray(off, off + 3200));
      chunker.flush();
      await Promise.all(pending);
      await this.store.updateLecture(lecture.id, { durationMs: Math.round((pcm.length / 32000) * 1000) });
      void this.finishAudioLecture(lecture.id);
    } catch (err) {
      await this.fail(lecture.id, `Could not read audio file: ${(err as Error).message}`);
    }
    return lecture;
  }

  /** Retry a lecture that failed (transcription or card generation). */
  async retry(lectureId: string) {
    const l = await this.store.getLecture(lectureId);
    if (!l) return;
    const chunks = await this.store.listChunks(lectureId);
    if (chunks.some((c) => c.text === undefined)) {
      await this.store.updateLecture(lectureId, { state: 'transcribing', error: undefined });
      this.changed.emit();
      await this.queue.retry(lectureId);
      void this.finishAudioLecture(lectureId);
    } else {
      void this.generateFor(lectureId);
    }
  }

  private async finishAudioLecture(lectureId: string) {
    if (!this.transcriber()) {
      const minutes = Math.max(1, Math.round(((await this.store.getLecture(lectureId))?.durationMs ?? 0) / 60000));
      await this.fail(lectureId, `Audio saved (${minutes} min) but no transcription backend is set up. Add one in Settings, then tap Retry.`);
      return;
    }
    const { failed } = await this.queue.drain(lectureId);
    if (failed) {
      const c = await this.queue.counts(lectureId);
      await this.fail(lectureId, `${failed} of ${c.total} audio chunks could not be transcribed (${c.lastError ?? 'unknown error'}). Audio is kept; tap Retry.`);
      return;
    }
    await this.generateFor(lectureId);
  }

  async generateFor(lectureId: string) {
    const lecture = await this.store.updateLecture(lectureId, { state: 'generating', error: undefined });
    if (!lecture) return;
    if (!lecture.transcript.trim()) {
      await this.fail(lectureId, 'The transcript is empty, so there is nothing to make cards from.');
      return;
    }
    this.progress.set(lectureId, { phase: 'generating', done: 0, total: 1 });
    this.changed.emit();
    try {
      const existing = (await this.store.listCards()).map((c) => ({ front: c.front }));
      const drafts = await generateCards(lecture.transcript, this.cardBackend(), {
        existing,
        onProgress: (done, total) => {
          this.progress.set(lectureId, { phase: 'generating', done, total });
          this.changed.emit();
        },
      });
      await this.store.putCards(drafts.map((d, i) => this.toCard(d, lectureId, i)));
      await this.store.updateLecture(lectureId, { state: 'ready' });
      this.progress.delete(lectureId);
      this.changed.emit();
    } catch (err) {
      await this.fail(lectureId, (err as Error).message);
    }
  }

  private toCard(d: DraftCard, lectureId: string, i: number): StudyCard {
    const now = Date.now();
    return {
      id: uid('k'),
      lectureId,
      front: d.front,
      back: d.back,
      sourceSnippet: d.sourceSnippet,
      status: 'draft',
      createdAt: now + i,
      srs: newSrs(new Date(now)),
    };
  }

  private async newLecture(title: string, source: LectureSource, state: Lecture['state'], transcript = ''): Promise<Lecture> {
    const lecture: Lecture = { id: uid('l'), title, createdAt: Date.now(), source, state, transcript, durationMs: 0 };
    await this.store.putLecture(lecture);
    this.changed.emit();
    return lecture;
  }

  private async fail(lectureId: string, error: string) {
    await this.store.updateLecture(lectureId, { state: 'error', error });
    this.progress.delete(lectureId);
    this.changed.emit();
  }

  private async onTranscriptionProgress(lectureId: string) {
    const c = await this.queue.counts(lectureId);
    const cur = this.progress.get(lectureId);
    if (cur?.phase !== 'generating') this.progress.set(lectureId, { phase: cur?.phase ?? 'transcribing', done: c.done, total: c.total });
    this.lastTranscriptTail = c.lastText;
    this.changed.emit();
  }

  /** Latest transcribed text, for the live view on the glasses. */
  lastTranscriptTail = '';

  // --- review ----------------------------------------------------------------

  /** `timeScale` > 1 when `now` is a sped-up demo clock: a card then uses scale x more clock time. */
  async startReview(opts: { limit?: number; endsAt?: number; now?: () => number; timeScale?: number } = {}): Promise<ReviewSession> {
    const s = this.settings.get();
    const cards = await this.store.listCards();
    const reviews = await this.store.recentReviews(500);
    const byId = new Map(cards.map((c) => [c.id, c]));
    const now = opts.now?.() ?? Date.now();
    const newAllowance = Math.max(0, s.review.newCardsPerDay - newCardsSeenToday(reviews, byId, new Date(now)));
    const queue = buildQueue(cards, { now, limit: opts.limit, newAllowance });
    return new ReviewSession(queue, {
      id: uid('s'),
      endsAt: opts.endsAt,
      secondsPerCard: secondsPerCard(reviews, s.commute.defaultSecondsPerCard),
      now: opts.now,
      timeScale: opts.timeScale,
    });
  }

  async answer(session: ReviewSession, verdict: Verdict) {
    const res = session.answer(verdict);
    if (!res) return;
    await this.store.putCard(res.card);
    await this.store.putReview({ ...res.log, id: uid('r') });
    this.changed.emit();
  }

  // --- commute ---------------------------------------------------------------

  async commuteOffer(now = Date.now(), refresh = false): Promise<CommuteOffer> {
    if (refresh) this.connCache = undefined;
    const s = this.settings.get();
    const reviews = await this.store.recentReviews(200);
    const spc = secondsPerCard(reviews, s.commute.defaultSecondsPerCard);
    let error: string | undefined;
    let plan: CommutePlan;
    try {
      const key = `${s.commute.from}|${s.commute.to}`;
      if (!this.connCache || this.connCache.key !== key || Date.now() - this.connCache.at > 60_000) {
        this.connCache = { key, at: Date.now(), conns: await fetchConnections(s.commute.from, s.commute.to, { limit: 4 }) };
      }
      const conn = nextCatchable(this.connCache.conns, now);
      if (!conn) throw new Error('No upcoming connection found');
      plan = planCommute({ connection: conn, bufferMin: s.commute.bufferMin, secondsPerCard: spc, now });
    } catch (err) {
      error = `${(err as Error).message}. Using a 20 min ride instead.`;
      plan = planCommute({ manualMinutes: 20, bufferMin: s.commute.bufferMin, secondsPerCard: spc, now });
    }
    const cards = await this.store.listCards();
    const st = deckStats(cards, now);
    const byId = new Map(cards.map((c) => [c.id, c]));
    const allowance = Math.max(0, s.review.newCardsPerDay - newCardsSeenToday(reviews, byId, new Date(now)));
    const size = buildQueue(cards, { now, limit: plan.capacity, newAllowance: allowance }).length;
    this.lastCommute = { plan, due: st.due, fresh: Math.min(st.newCards, allowance), size, error };
    return this.lastCommute;
  }

  get cachedCommute(): CommuteOffer | undefined {
    return this.lastCommute;
  }
}

function defaultTitle(kind: string): string {
  const d = new Date();
  return `${kind} ${d.toLocaleDateString('en-GB', { day: 'numeric', month: 'short' })} ${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}`;
}
