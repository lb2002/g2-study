import { floatToS16, resample } from '../audio/pcm';
import { Emitter, type GlassesHost } from './host';
import type { Gesture } from './input';
import { LINE_H, SCREEN_H, SCREEN_W, wrapLines, type ListBox, type Page, type TextBox } from './page';

/**
 * Stand-in for the glasses when the page runs in a normal browser: draws the
 * page on a 576 x 288 canvas, maps keys/buttons to gestures and uses the
 * browser microphone for audio. Not pixel-accurate; the official simulator is.
 */
export class PreviewHost implements GlassesHost {
  readonly kind = 'preview' as const;
  private gestures = new Emitter<Gesture>();
  private audio = new Emitter<Uint8Array>();
  private page?: Page;
  private listIndex = new Map<string, number>();
  private ctx: CanvasRenderingContext2D;
  private mic?: { stop: () => void };

  constructor(canvas: HTMLCanvasElement) {
    canvas.width = SCREEN_W;
    canvas.height = SCREEN_H;
    this.ctx = canvas.getContext('2d')!;
    this.bindKeys();
  }

  async show(page: Page): Promise<void> {
    const prev = this.page;
    this.page = page;
    // A rebuilt page resets list focus, like the firmware does.
    if (!prev || prev.boxes.some((b, i) => b.type === 'list' && page.boxes[i]?.name !== b.name)) this.listIndex.clear();
    this.draw();
  }

  onGesture(cb: (g: Gesture) => void) {
    return this.gestures.on(cb);
  }

  onAudio(cb: (pcm: Uint8Array) => void) {
    return this.audio.on(cb);
  }

  /** Feed a gesture as if it came from the touchpad (buttons in the preview panel use this). */
  press(g: Gesture['type']): void {
    const list = this.page?.boxes.find((b): b is ListBox => b.type === 'list' && !!b.capture);
    if (list && (g === 'up' || g === 'down')) {
      const cur = this.listIndex.get(list.name) ?? 0;
      const next = Math.max(0, Math.min(list.items.length - 1, cur + (g === 'down' ? 1 : -1)));
      this.listIndex.set(list.name, next);
      this.draw();
      return;
    }
    if (list && g === 'tap') {
      this.gestures.emit({ type: 'tap', listIndex: this.listIndex.get(list.name) ?? 0, listName: list.name });
      return;
    }
    this.gestures.emit({ type: g } as Gesture);
  }

  async setMic(on: boolean): Promise<boolean> {
    if (!on) {
      this.mic?.stop();
      this.mic = undefined;
      return true;
    }
    if (this.mic) return true;
    try {
      this.mic = await startBrowserMic((pcm) => this.audio.emit(pcm));
      return true;
    } catch (err) {
      console.warn('Browser microphone unavailable', err);
      return false;
    }
  }

  async exit(): Promise<void> {
    this.page = { boxes: [{ type: 'text', id: 1, name: 'bye', x: 0, y: 120, w: SCREEN_W, h: 40, content: '(plugin closed)', brightness: 2 }] };
    this.draw();
  }

  private bindKeys() {
    let holding = false;
    window.addEventListener('keydown', (e) => {
      if (isTyping(e)) return;
      const map: Record<string, Gesture['type']> = { ArrowUp: 'up', ArrowDown: 'down', Enter: 'tap', ' ': 'tap', Backspace: 'double', Escape: 'double' };
      if (map[e.key]) {
        e.preventDefault();
        this.press(map[e.key]);
      } else if ((e.key === 'h' || e.key === 'H') && !holding) {
        holding = true;
        this.press('hold');
      }
    });
    window.addEventListener('keyup', (e) => {
      if ((e.key === 'h' || e.key === 'H') && holding) {
        holding = false;
        this.press('holdEnd');
      }
    });
  }

  private draw() {
    const c = this.ctx;
    c.fillStyle = '#000';
    c.fillRect(0, 0, SCREEN_W, SCREEN_H);
    for (const box of this.page?.boxes ?? []) {
      if (box.type === 'text') this.drawText(box);
      else this.drawList(box);
    }
  }

  private color(level = 4) {
    const alpha = [0.18, 0.38, 0.58, 0.8, 1][level] ?? 1;
    return `rgba(64, 255, 96, ${alpha})`;
  }

  private drawText(b: TextBox) {
    const c = this.ctx;
    if (b.border?.width) {
      c.strokeStyle = this.color(Math.round((b.border.color / 15) * 4));
      c.lineWidth = b.border.width;
      roundRect(c, b.x + 1, b.y + 1, b.w - 2, b.h - 2, b.border.radius);
      c.stroke();
    }
    const pad = b.padding ?? 0;
    c.font = '20px "Segoe UI", system-ui, sans-serif';
    c.fillStyle = this.color(b.brightness);
    c.textBaseline = 'top';
    const lines = wrapLines(b.content, b.w - pad * 2);
    lines.forEach((line, i) => {
      const y = b.y + pad + 3 + i * LINE_H;
      if (y + LINE_H <= b.y + b.h + 4) c.fillText(line, b.x + pad, y);
    });
  }

  private drawList(b: ListBox) {
    const c = this.ctx;
    const sel = this.listIndex.get(b.name) ?? 0;
    const rowH = 40;
    c.font = '20px "Segoe UI", system-ui, sans-serif';
    c.textBaseline = 'middle';
    const first = Math.max(0, sel - Math.floor(b.h / rowH) + 1);
    b.items.slice(first).forEach((item, k) => {
      const i = first + k;
      const y = b.y + k * rowH;
      if (y + rowH > b.y + b.h) return;
      if (i === sel) {
        c.strokeStyle = this.color(4);
        c.lineWidth = 2;
        roundRect(c, b.x + 1, y + 1, b.w - 2, rowH - 4, 8);
        c.stroke();
      }
      c.fillStyle = this.color(i === sel ? 4 : 2);
      c.fillText(item, b.x + 12, y + rowH / 2 - 1);
    });
  }
}

function roundRect(c: CanvasRenderingContext2D, x: number, y: number, w: number, h: number, r: number) {
  c.beginPath();
  c.roundRect(x, y, w, h, r);
}

function isTyping(e: KeyboardEvent): boolean {
  const t = e.target as HTMLElement | null;
  return !!t && (t.tagName === 'INPUT' || t.tagName === 'TEXTAREA' || t.tagName === 'SELECT' || t.isContentEditable);
}

/** Browser mic -> 100 ms frames of 16 kHz s16le, matching what the glasses send. */
async function startBrowserMic(onFrame: (pcm: Uint8Array) => void): Promise<{ stop: () => void }> {
  const stream = await navigator.mediaDevices.getUserMedia({ audio: { channelCount: 1, echoCancellation: false, noiseSuppression: true } });
  const ctx = new AudioContext();
  const src = ctx.createMediaStreamSource(stream);
  // ScriptProcessor is deprecated but universally available and fine for a dev preview.
  const proc = ctx.createScriptProcessor(4096, 1, 1);
  let pending = new Float32Array(0);
  proc.onaudioprocess = (ev) => {
    const input = resample(ev.inputBuffer.getChannelData(0), ctx.sampleRate);
    const merged = new Float32Array(pending.length + input.length);
    merged.set(pending);
    merged.set(input, pending.length);
    let off = 0;
    while (merged.length - off >= 1600) {
      onFrame(floatToS16(merged.subarray(off, off + 1600)));
      off += 1600;
    }
    pending = merged.slice(off);
  };
  src.connect(proc);
  proc.connect(ctx.destination);
  return {
    stop: () => {
      proc.disconnect();
      src.disconnect();
      stream.getTracks().forEach((t) => t.stop());
      void ctx.close();
    },
  };
}
