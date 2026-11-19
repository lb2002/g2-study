/**
 * PCM helpers. The G2 delivers 16 kHz, signed 16-bit little-endian, mono PCM
 * in ~100 ms frames (3200 bytes). Everything here works on that format.
 */
export const SAMPLE_RATE = 16_000;
export const BYTES_PER_SAMPLE = 2;
export const BYTES_PER_SECOND = SAMPLE_RATE * BYTES_PER_SAMPLE;

export function bytesToMs(bytes: number): number {
  return Math.round((bytes / BYTES_PER_SECOND) * 1000);
}

/** Root-mean-square level of an s16le buffer, 0..1. */
export function rms(pcm: Uint8Array): number {
  const n = Math.floor(pcm.length / 2);
  if (n === 0) return 0;
  const view = new DataView(pcm.buffer, pcm.byteOffset, n * 2);
  let sum = 0;
  for (let i = 0; i < n; i++) {
    const s = view.getInt16(i * 2, true) / 32768;
    sum += s * s;
  }
  return Math.sqrt(sum / n);
}

export interface ChunkerOptions {
  /** Target chunk length; we start looking for a pause this many seconds before it. */
  targetSeconds: number;
  /** Look for a quiet frame in [target - window, target + window]. */
  searchWindowSeconds?: number;
  /** A frame counts as a pause when its RMS is below this fraction of the recent median. */
  silenceRatio?: number;
}

export interface PcmChunk {
  index: number;
  pcm: Uint8Array;
  durationMs: number;
}

/**
 * Collects incoming PCM frames and emits ~targetSeconds chunks, preferring to
 * cut at a pause so words are not split between two transcription requests.
 */
export class PcmChunker {
  private frames: Uint8Array[] = [];
  private frameLevels: number[] = [];
  private bufferedBytes = 0;
  private nextIndex = 0;
  private readonly minBytes: number;
  private readonly maxBytes: number;
  private readonly silenceRatio: number;

  constructor(
    opts: ChunkerOptions,
    private onChunk: (chunk: PcmChunk) => void,
  ) {
    const window = opts.searchWindowSeconds ?? Math.min(5, opts.targetSeconds / 6);
    this.minBytes = Math.max(1, (opts.targetSeconds - window) * BYTES_PER_SECOND);
    this.maxBytes = (opts.targetSeconds + window) * BYTES_PER_SECOND;
    this.silenceRatio = opts.silenceRatio ?? 0.35;
  }

  get bufferedMs(): number {
    return bytesToMs(this.bufferedBytes);
  }

  push(frame: Uint8Array): void {
    if (frame.length === 0) return;
    // Copy: the bridge may reuse its buffer.
    const copy = frame.slice();
    const level = rms(copy);
    const quietThreshold = this.medianLevel() * this.silenceRatio;
    this.frames.push(copy);
    this.frameLevels.push(level);
    this.bufferedBytes += copy.length;

    const pastMin = this.bufferedBytes >= this.minBytes;
    const isPause = pastMin && this.frameLevels.length > 10 && level <= quietThreshold;
    if (isPause || this.bufferedBytes >= this.maxBytes) this.emit();
  }

  /** Emit whatever is buffered (call on stop). */
  flush(): void {
    if (this.bufferedBytes > 0) this.emit();
  }

  private medianLevel(): number {
    const recent = this.frameLevels.slice(-100);
    if (recent.length === 0) return 0;
    const sorted = [...recent].sort((a, b) => a - b);
    return sorted[Math.floor(sorted.length / 2)];
  }

  private emit(): void {
    const pcm = concat(this.frames, this.bufferedBytes);
    this.onChunk({ index: this.nextIndex++, pcm, durationMs: bytesToMs(pcm.length) });
    this.frames = [];
    this.frameLevels = [];
    this.bufferedBytes = 0;
  }
}

export function concat(parts: Uint8Array[], total = parts.reduce((n, p) => n + p.length, 0)): Uint8Array {
  const out = new Uint8Array(total);
  let off = 0;
  for (const p of parts) {
    out.set(p, off);
    off += p.length;
  }
  return out;
}

/** Wrap raw s16le mono PCM in a 44-byte WAV header. */
export function encodeWav(pcm: Uint8Array, sampleRate = SAMPLE_RATE): Uint8Array {
  const header = new ArrayBuffer(44);
  const v = new DataView(header);
  const writeStr = (off: number, s: string) => [...s].forEach((c, i) => v.setUint8(off + i, c.charCodeAt(0)));
  writeStr(0, 'RIFF');
  v.setUint32(4, 36 + pcm.length, true);
  writeStr(8, 'WAVE');
  writeStr(12, 'fmt ');
  v.setUint32(16, 16, true); // fmt chunk size
  v.setUint16(20, 1, true); // PCM
  v.setUint16(22, 1, true); // mono
  v.setUint32(24, sampleRate, true);
  v.setUint32(28, sampleRate * BYTES_PER_SAMPLE, true);
  v.setUint16(32, BYTES_PER_SAMPLE, true);
  v.setUint16(34, 16, true);
  writeStr(36, 'data');
  v.setUint32(40, pcm.length, true);
  return concat([new Uint8Array(header), pcm]);
}

/** Convert float samples (-1..1) to s16le bytes. */
export function floatToS16(samples: Float32Array): Uint8Array {
  const out = new Uint8Array(samples.length * 2);
  const v = new DataView(out.buffer);
  for (let i = 0; i < samples.length; i++) {
    const s = Math.max(-1, Math.min(1, samples[i]));
    v.setInt16(i * 2, s < 0 ? s * 0x8000 : s * 0x7fff, true);
  }
  return out;
}

/** Linear-interpolation resampler, good enough for speech going to Whisper. */
export function resample(input: Float32Array, fromRate: number, toRate = SAMPLE_RATE): Float32Array {
  if (fromRate === toRate) return input;
  const ratio = fromRate / toRate;
  const outLen = Math.floor(input.length / ratio);
  const out = new Float32Array(outLen);
  for (let i = 0; i < outLen; i++) {
    const pos = i * ratio;
    const i0 = Math.floor(pos);
    const i1 = Math.min(i0 + 1, input.length - 1);
    const frac = pos - i0;
    out[i] = input[i0] * (1 - frac) + input[i1] * frac;
  }
  return out;
}
