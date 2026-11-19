import { describe, expect, it } from 'vitest';
import { BYTES_PER_SECOND, PcmChunker, encodeWav, floatToS16, resample, rms, type PcmChunk } from '../src/audio/pcm';

/** 100 ms frame of a sine tone (loud) or near-silence (quiet). */
function frame(loud: boolean): Uint8Array {
  const samples = new Float32Array(1600);
  for (let i = 0; i < samples.length; i++) samples[i] = loud ? 0.5 * Math.sin(i / 5) : 0.001 * Math.sin(i / 5);
  return floatToS16(samples);
}

describe('rms', () => {
  it('is ~0 for silence and higher for a tone', () => {
    expect(rms(frame(false))).toBeLessThan(0.01);
    expect(rms(frame(true))).toBeGreaterThan(0.3);
  });
});

describe('PcmChunker', () => {
  it('cuts at a pause once past the minimum length', () => {
    const chunks: PcmChunk[] = [];
    const c = new PcmChunker({ targetSeconds: 10, searchWindowSeconds: 2 }, (ch) => chunks.push(ch));
    // 9 s of speech, then a pause frame: min is 8 s, so the pause at 9.1 s triggers a cut.
    for (let i = 0; i < 90; i++) c.push(frame(true));
    expect(chunks).toHaveLength(0);
    c.push(frame(false));
    expect(chunks).toHaveLength(1);
    expect(chunks[0].durationMs).toBe(9100);
    expect(chunks[0].index).toBe(0);
  });

  it('hard-cuts at target + window when nobody pauses', () => {
    const chunks: PcmChunk[] = [];
    const c = new PcmChunker({ targetSeconds: 10, searchWindowSeconds: 2 }, (ch) => chunks.push(ch));
    for (let i = 0; i < 250; i++) c.push(frame(true));
    expect(chunks.map((ch) => ch.durationMs)).toEqual([12000, 12000]);
    c.flush();
    expect(chunks).toHaveLength(3);
    expect(chunks[2].durationMs).toBe(1000);
    expect(chunks.map((ch) => ch.index)).toEqual([0, 1, 2]);
  });

  it('ignores pauses before the minimum length', () => {
    const chunks: PcmChunk[] = [];
    const c = new PcmChunker({ targetSeconds: 10, searchWindowSeconds: 2 }, (ch) => chunks.push(ch));
    for (let i = 0; i < 30; i++) c.push(frame(i % 10 !== 0));
    expect(chunks).toHaveLength(0);
    expect(c.bufferedMs).toBe(3000);
  });
});

describe('encodeWav', () => {
  it('writes a valid 16 kHz mono header', () => {
    const pcm = new Uint8Array(BYTES_PER_SECOND);
    const wav = encodeWav(pcm);
    const v = new DataView(wav.buffer);
    expect(new TextDecoder().decode(wav.slice(0, 4))).toBe('RIFF');
    expect(new TextDecoder().decode(wav.slice(8, 12))).toBe('WAVE');
    expect(v.getUint16(22, true)).toBe(1);
    expect(v.getUint32(24, true)).toBe(16000);
    expect(v.getUint32(40, true)).toBe(pcm.length);
    expect(wav.length).toBe(44 + pcm.length);
  });
});

describe('resample', () => {
  it('changes length by the rate ratio', () => {
    expect(resample(new Float32Array(48000), 48000).length).toBe(16000);
    expect(resample(new Float32Array(44100), 44100).length).toBe(16000);
  });
});
