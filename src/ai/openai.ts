import type { DraftCard } from '../types';
import { buildCardPrompt, parseCardJson, type CardBackend } from './cards';

export interface OpenAICompatConfig {
  baseUrl: string;
  model: string;
  apiKey: string;
  language?: string;
}

export function joinUrl(base: string, path: string): string {
  return base.replace(/\/+$/, '') + '/' + path.replace(/^\/+/, '');
}

export async function readError(res: Response): Promise<string> {
  const body = await res.text().catch(() => '');
  try {
    const j = JSON.parse(body);
    return `${res.status} ${j?.error?.message ?? j?.detail ?? j?.message ?? body}`.slice(0, 300);
  } catch {
    return `${res.status} ${res.statusText} ${body}`.trim().slice(0, 300);
  }
}

/**
 * Any server that speaks the OpenAI chat-completions protocol: OpenAI,
 * Ollama (/v1), llama.cpp server, vLLM, LM Studio, OpenRouter...
 */
export class OpenAICompatBackend implements CardBackend {
  readonly name: string;

  constructor(
    private cfg: OpenAICompatConfig,
    private fetchImpl: typeof fetch = (...a) => fetch(...a),
  ) {
    this.name = `${cfg.model} @ ${new URL(cfg.baseUrl).host}`;
  }

  async generate(chunk: string, ctx: { chunkIndex: number; chunkCount: number; targetCards: number }): Promise<DraftCard[]> {
    const { system, user } = buildCardPrompt(chunk, { ...ctx, language: this.cfg.language });
    const body = {
      model: this.cfg.model,
      temperature: 0.2,
      response_format: { type: 'json_object' },
      messages: [
        { role: 'system', content: system },
        { role: 'user', content: user },
      ],
    };
    let res = await this.post(body);
    // Some local servers reject response_format; retry once without it.
    if (res.status === 400) {
      const { response_format: _drop, ...plain } = body;
      res = await this.post(plain);
    }
    if (!res.ok) throw new Error(`Card generation failed: ${await readError(res)}`);
    const json = await res.json();
    const content: string = json?.choices?.[0]?.message?.content ?? '';
    return parseCardJson(content);
  }

  private post(body: unknown): Promise<Response> {
    const headers: Record<string, string> = { 'Content-Type': 'application/json' };
    if (this.cfg.apiKey) headers.Authorization = `Bearer ${this.cfg.apiKey}`;
    return this.fetchImpl(joinUrl(this.cfg.baseUrl, 'chat/completions'), {
      method: 'POST',
      headers,
      body: JSON.stringify(body),
    });
  }
}
