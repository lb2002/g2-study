import { joinUrl, readError } from './openai';

export interface Transcriber {
  readonly name: string;
  /** `prompt` is the tail of the transcript so far; Whisper uses it to keep terms and spelling consistent. */
  transcribe(wav: Blob, opts: { prompt?: string; signal?: AbortSignal }): Promise<string>;
}

export interface WhisperConfig {
  baseUrl: string;
  model: string;
  apiKey: string;
  language?: string;
}

/**
 * POST {baseUrl}/audio/transcriptions, multipart. Works with the OpenAI API
 * and with self-hosted Whisper servers that copy its interface
 * (faster-whisper-server / speaches, whisper.cpp server with --inference-path, LocalAI...).
 */
export class WhisperHttpTranscriber implements Transcriber {
  readonly name: string;

  constructor(
    private cfg: WhisperConfig,
    private fetchImpl: typeof fetch = (...a) => fetch(...a),
  ) {
    this.name = `${cfg.model} @ ${new URL(cfg.baseUrl).host}`;
  }

  async transcribe(wav: Blob, opts: { prompt?: string; signal?: AbortSignal } = {}): Promise<string> {
    const form = new FormData();
    form.append('file', wav, 'chunk.wav');
    form.append('model', this.cfg.model);
    form.append('response_format', 'json');
    if (this.cfg.language) form.append('language', this.cfg.language);
    if (opts.prompt) form.append('prompt', opts.prompt.slice(-800));
    const headers: Record<string, string> = {};
    if (this.cfg.apiKey) headers.Authorization = `Bearer ${this.cfg.apiKey}`;
    const res = await this.fetchImpl(joinUrl(this.cfg.baseUrl, 'audio/transcriptions'), {
      method: 'POST',
      headers,
      body: form,
      signal: opts.signal,
    });
    if (!res.ok) throw new Error(`Transcription failed: ${await readError(res)}`);
    const type = res.headers.get('content-type') ?? '';
    if (type.includes('json')) {
      const j = await res.json();
      return String(j?.text ?? '').trim();
    }
    return (await res.text()).trim();
  }
}
