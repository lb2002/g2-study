/**
 * User settings. Stored in the webview's localStorage (persisted on device,
 * sandboxed per plugin, cleared on uninstall). Keys never touch the repo.
 */
export type TranscribeProvider = 'whisper-http' | 'none';
export type CardProvider = 'openai-compatible' | 'offline';
export type MicSource = 'glasses' | 'phone';

export interface Settings {
  transcribe: {
    provider: TranscribeProvider;
    /** Base URL of a Whisper-compatible API, e.g. https://api.openai.com/v1 or http://homeserver:8000/v1 */
    baseUrl: string;
    model: string;
    apiKey: string;
    /** ISO-639-1 hint, empty for auto-detect. */
    language: string;
  };
  cards: {
    provider: CardProvider;
    /** Base URL of an OpenAI-compatible chat API (OpenAI, Ollama, llama.cpp, vLLM, LM Studio...). */
    baseUrl: string;
    model: string;
    apiKey: string;
    /** Language the cards should be written in; empty = same as the lecture. */
    language: string;
  };
  recording: {
    mic: MicSource;
    chunkSeconds: number;
  };
  commute: {
    from: string;
    to: string;
    /** Stop the round this many minutes before arrival. */
    bufferMin: number;
    /** Fallback when there is no review history yet. */
    defaultSecondsPerCard: number;
  };
  review: {
    newCardsPerDay: number;
  };
  demo: {
    /** Speeds up the commute clock so a 20 min ride can be shown in a 1 min video. 1 = real time. */
    timeScale: number;
  };
}

export const DEFAULT_SETTINGS: Settings = {
  transcribe: {
    provider: 'whisper-http',
    baseUrl: import.meta.env.VITE_TRANSCRIBE_BASE_URL || 'https://api.openai.com/v1',
    model: import.meta.env.VITE_TRANSCRIBE_MODEL || 'whisper-1',
    apiKey: import.meta.env.VITE_TRANSCRIBE_API_KEY || '',
    language: '',
  },
  cards: {
    provider: 'offline',
    baseUrl: import.meta.env.VITE_LLM_BASE_URL || 'https://api.openai.com/v1',
    model: import.meta.env.VITE_LLM_MODEL || 'gpt-4o-mini',
    apiKey: import.meta.env.VITE_LLM_API_KEY || '',
    language: '',
  },
  recording: { mic: 'glasses', chunkSeconds: 60 },
  commute: { from: 'Winterthur', to: 'Zürich HB', bufferMin: 2, defaultSecondsPerCard: 10 },
  review: { newCardsPerDay: 25 },
  demo: { timeScale: 1 },
};

const KEY = 'g2study.settings.v1';

type Listener = (s: Settings) => void;

export class SettingsStore {
  private value: Settings;
  private listeners = new Set<Listener>();

  constructor(private storage: Pick<Storage, 'getItem' | 'setItem'> | null = safeLocalStorage()) {
    this.value = this.load();
    // If a key was provided for local dev, assume the user wants the real backend.
    if (!this.storage?.getItem(KEY) && this.value.cards.apiKey) this.value.cards.provider = 'openai-compatible';
  }

  get(): Settings {
    return this.value;
  }

  update(mutator: (draft: Settings) => void): Settings {
    const draft = structuredClone(this.value);
    mutator(draft);
    this.value = draft;
    try {
      this.storage?.setItem(KEY, JSON.stringify(draft));
    } catch {
      /* storage full or blocked: settings stay in memory for this session */
    }
    this.listeners.forEach((l) => l(draft));
    return draft;
  }

  /** Change settings for this page load only, without saving them. */
  overrideForSession(mutator: (draft: Settings) => void): Settings {
    const draft = structuredClone(this.value);
    mutator(draft);
    this.value = draft;
    this.listeners.forEach((l) => l(draft));
    return draft;
  }

  subscribe(l: Listener): () => void {
    this.listeners.add(l);
    return () => this.listeners.delete(l);
  }

  private load(): Settings {
    try {
      const raw = this.storage?.getItem(KEY);
      if (!raw) return structuredClone(DEFAULT_SETTINGS);
      return deepMerge(structuredClone(DEFAULT_SETTINGS), JSON.parse(raw));
    } catch {
      return structuredClone(DEFAULT_SETTINGS);
    }
  }
}

function deepMerge<T>(base: T, patch: unknown): T {
  if (!patch || typeof patch !== 'object') return base;
  for (const [k, v] of Object.entries(patch as Record<string, unknown>)) {
    const cur = (base as Record<string, unknown>)[k];
    if (cur && typeof cur === 'object' && v && typeof v === 'object') deepMerge(cur, v);
    else if (k in (base as object) && typeof v === typeof cur) (base as Record<string, unknown>)[k] = v;
  }
  return base;
}

function safeLocalStorage(): Storage | null {
  try {
    return typeof localStorage === 'undefined' ? null : localStorage;
  } catch {
    return null;
  }
}
