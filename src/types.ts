import type { Card as FsrsCard } from 'ts-fsrs';

/** Hard limits that keep a card readable on the 576 x 288 glasses display. */
export const FRONT_MAX = 60;
export const BACK_MAX = 120;

export type CardStatus = 'draft' | 'active';

export interface StudyCard {
  id: string;
  lectureId: string;
  front: string;
  back: string;
  sourceSnippet: string;
  status: CardStatus;
  createdAt: number;
  /** FSRS scheduling state; dates are stored as epoch ms so IndexedDB round-trips cleanly. */
  srs: StoredSrs;
}

export type StoredSrs = Omit<FsrsCard, 'due' | 'last_review'> & { due: number; last_review?: number };

export type LectureSource = 'glasses-mic' | 'phone-mic' | 'browser-mic' | 'audio-file' | 'text';

export type LectureState = 'recording' | 'transcribing' | 'generating' | 'ready' | 'error';

export interface Lecture {
  id: string;
  title: string;
  createdAt: number;
  source: LectureSource;
  state: LectureState;
  transcript: string;
  /** Recording duration in ms (audio sources only). */
  durationMs: number;
  error?: string;
  /** Mic diagnostics, so a long real-hardware session tells us where capture broke. */
  diagnostics?: RecordingDiagnostics;
}

export interface RecordingDiagnostics {
  framesReceived: number;
  bytesReceived: number;
  gaps: { atMs: number; lengthMs: number }[];
  chunksTotal: number;
  chunksFailed: number;
}

/** A recorded audio chunk waiting for (or done with) transcription. */
export interface AudioChunk {
  id: string;
  lectureId: string;
  index: number;
  /** 16 kHz mono s16le WAV. Deleted once transcribed. */
  wav?: Blob;
  durationMs: number;
  text?: string;
  attempts: number;
  lastError?: string;
}

export interface ReviewLogEntry {
  id: string;
  cardId: string;
  at: number;
  rating: 'good' | 'again';
  /** Time from showing the front to grading, in ms. */
  durationMs: number;
  sessionId: string;
}

export interface DraftCard {
  front: string;
  back: string;
  sourceSnippet: string;
}
