import type { MicSource } from '../settings';
import type { Gesture } from './input';
import type { Page } from './page';

/** What the app needs from "the glasses", real or simulated. */
export interface GlassesHost {
  readonly kind: 'even' | 'preview';
  /** Show a page; implementations update in place when only text changed. */
  show(page: Page): Promise<void>;
  onGesture(cb: (g: Gesture) => void): () => void;
  /** 16 kHz s16le mono frames. */
  onAudio(cb: (pcm: Uint8Array) => void): () => void;
  setMic(on: boolean, source: MicSource): Promise<boolean>;
  /** Root-page exit: shows the system exit dialog. */
  exit(): Promise<void>;
}

export class Emitter<T> {
  private subs = new Set<(v: T) => void>();
  on(cb: (v: T) => void): () => void {
    this.subs.add(cb);
    return () => this.subs.delete(cb);
  }
  emit(v: T) {
    this.subs.forEach((s) => {
      try {
        s(v);
      } catch (err) {
        console.error(err);
      }
    });
  }
}
