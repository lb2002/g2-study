#!/usr/bin/env node
/**
 * MOCK transcription server for testing the recording pipeline without an API
 * key. It speaks the OpenAI /v1/audio/transcriptions protocol but ignores the
 * audio and returns the next few sentences of samples/public-key-crypto.txt.
 *
 * It is a plumbing test, not speech recognition. Do not use it in a demo that
 * claims to show live transcription.
 *
 *   node scripts/mock-whisper.mjs        # listens on http://localhost:8787/v1
 *   Settings > Transcription > Base URL = http://localhost:8787/v1, Model = mock
 */
import { createServer } from 'node:http';
import { readFileSync } from 'node:fs';

const PORT = Number(process.env.PORT ?? 8787);
const sentences = readFileSync(new URL('../samples/public-key-crypto.txt', import.meta.url), 'utf8')
  .replace(/\s+/g, ' ')
  .split(/(?<=[.!?])\s+/);
let pos = 0;

const cors = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'Authorization, Content-Type',
  'Access-Control-Allow-Methods': 'POST, OPTIONS',
};

createServer((req, res) => {
  if (req.method === 'OPTIONS') return res.writeHead(204, cors).end();
  if (req.method !== 'POST' || !req.url?.endsWith('/audio/transcriptions')) {
    return res.writeHead(404, cors).end('not found');
  }
  let bytes = 0;
  req.on('data', (c) => (bytes += c.length));
  req.on('end', () => {
    // ~one sentence per 10 s of 16 kHz mono audio, like a slow lecturer.
    const n = Math.max(1, Math.round(bytes / 320_000));
    const text = sentences.slice(pos, pos + n).join(' ');
    pos = (pos + n) % sentences.length;
    console.log(`[mock-whisper] ${Math.round(bytes / 1024)} KiB -> "${text.slice(0, 60)}..."`);
    res.writeHead(200, { ...cors, 'Content-Type': 'application/json' }).end(JSON.stringify({ text }));
  });
}).listen(PORT, () => console.log(`[mock-whisper] http://localhost:${PORT}/v1 (replays the sample lecture, ignores audio)`));
