import { SAMPLE_RATE, floatToS16 } from './pcm';

/**
 * Decode any audio file the webview understands (mp3, m4a, wav, ogg...) and
 * resample it to 16 kHz mono s16le, the same format the glasses deliver.
 */
export async function decodeAudioFile(file: Blob): Promise<Uint8Array> {
  const data = await file.arrayBuffer();
  const ctx = new AudioContext();
  let decoded: AudioBuffer;
  try {
    decoded = await ctx.decodeAudioData(data);
  } finally {
    void ctx.close();
  }
  const frames = Math.ceil(decoded.duration * SAMPLE_RATE);
  const offline = new OfflineAudioContext(1, frames, SAMPLE_RATE);
  const src = offline.createBufferSource();
  src.buffer = decoded; // multi-channel input is down-mixed to the mono destination
  src.connect(offline.destination);
  src.start();
  const rendered = await offline.startRendering();
  return floatToS16(rendered.getChannelData(0));
}
