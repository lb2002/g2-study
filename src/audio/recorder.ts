import type { GlassesHost } from '../glasses/host';
import type { MicSource } from '../settings';
import type { RecordingDiagnostics } from '../types';
import { PcmChunker } from './pcm';

export interface RecorderStatus {
  recording: boolean;
  lectureId?: string;
  startedAt?: number;
  elapsedMs: number;
  /** No audio frames for a few seconds: mic paused, Bluetooth dropped or webview suspended. */
  stalled: boolean;
  diagnostics: RecordingDiagnostics;
}

const STALL_MS = 3_000;

/**
 * Turns the glasses (or phone) microphone stream into numbered PCM chunks and
 * keeps diagnostics about gaps, which is exactly what we need to learn whether
 * a 90 minute lecture survives on real hardware.
 */
export class LectureRecorder {
  private chunker?: PcmChunker;
  private unsubAudio?: () => void;
  private timer?: ReturnType<typeof setInterval>;
  private lastFrameAt = 0;
  private gapStart?: number;
  private status: RecorderStatus = emptyStatus();
  private source: MicSource = 'glasses';

  constructor(
    private host: GlassesHost,
    private onChunk: (lectureId: string, index: number, pcm: Uint8Array, durationMs: number) => void,
    private onStatus: (s: RecorderStatus) => void,
  ) {}

  get current(): RecorderStatus {
    return { ...this.status, elapsedMs: this.status.startedAt ? Date.now() - this.status.startedAt : 0 };
  }

  async start(lectureId: string, source: MicSource, chunkSeconds: number): Promise<void> {
    if (this.status.recording) throw new Error('Already recording');
    this.source = source;
    this.status = { ...emptyStatus(), recording: true, lectureId, startedAt: Date.now() };
    this.chunker = new PcmChunker({ targetSeconds: chunkSeconds }, (c) => {
      this.status.diagnostics.chunksTotal++;
      this.onChunk(lectureId, c.index, c.pcm, c.durationMs);
    });
    this.lastFrameAt = Date.now();
    this.unsubAudio = this.host.onAudio((pcm) => this.onFrame(pcm));
    const ok = await this.host.setMic(true, source);
    if (!ok) {
      this.cleanup();
      throw new Error('Could not open the microphone');
    }
    this.timer = setInterval(() => this.tick(), 1000);
    this.emit();
  }

  /** Re-open the mic, e.g. after the app comes back to the foreground. */
  async resume(): Promise<void> {
    if (this.status.recording) await this.host.setMic(true, this.source);
  }

  async stop(): Promise<{ lectureId: string; durationMs: number; diagnostics: RecordingDiagnostics } | undefined> {
    if (!this.status.recording || !this.status.lectureId) return undefined;
    await this.host.setMic(false, this.source).catch(() => false);
    this.closeGap(Date.now());
    this.chunker?.flush();
    const result = {
      lectureId: this.status.lectureId,
      durationMs: Date.now() - (this.status.startedAt ?? Date.now()),
      diagnostics: structuredClone(this.status.diagnostics),
    };
    this.cleanup();
    this.status = emptyStatus();
    this.emit();
    return result;
  }

  private onFrame(pcm: Uint8Array) {
    const now = Date.now();
    this.closeGap(now);
    this.lastFrameAt = now;
    this.status.diagnostics.framesReceived++;
    this.status.diagnostics.bytesReceived += pcm.length;
    this.chunker?.push(pcm);
  }

  private tick() {
    const now = Date.now();
    const stalled = now - this.lastFrameAt > STALL_MS;
    if (stalled && this.gapStart === undefined) this.gapStart = this.lastFrameAt;
    this.status.stalled = stalled;
    this.emit();
  }

  private closeGap(now: number) {
    if (this.gapStart === undefined || !this.status.startedAt) return;
    this.status.diagnostics.gaps.push({ atMs: this.gapStart - this.status.startedAt, lengthMs: now - this.gapStart });
    this.gapStart = undefined;
    this.status.stalled = false;
  }

  private cleanup() {
    this.unsubAudio?.();
    this.unsubAudio = undefined;
    if (this.timer) clearInterval(this.timer);
    this.timer = undefined;
    this.chunker = undefined;
    this.gapStart = undefined;
  }

  private emit() {
    this.onStatus(this.current);
  }
}

function emptyStatus(): RecorderStatus {
  return {
    recording: false,
    elapsedMs: 0,
    stalled: false,
    diagnostics: { framesReceived: 0, bytesReceived: 0, gaps: [], chunksTotal: 0, chunksFailed: 0 },
  };
}
