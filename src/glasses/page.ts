/**
 * Display-independent page model. Hosts (real glasses via the Even Hub SDK, or
 * the in-browser preview) turn this into containers.
 *
 * Measured in evenhub-simulator 0.9.5: proportional font, ~29 px line height,
 * ~10 px average glyph width, so roughly 10 lines x 50 characters per screen.
 * Text wraps on word boundaries; overflowing containers get a scrollbar, and on
 * a text container a swipe then scrolls instead of reaching our handler. Every
 * layout below keeps its content inside its box for that reason.
 */
export const SCREEN_W = 576;
export const SCREEN_H = 288;
export const LINE_H = 29;

export type Brightness = 0 | 1 | 2 | 3 | 4;

export interface TextBox {
  type: 'text';
  id: number;
  name: string;
  x: number;
  y: number;
  w: number;
  h: number;
  content: string;
  brightness?: Brightness;
  border?: { width: number; color: number; radius: number };
  padding?: number;
  capture?: boolean;
}

export interface ListBox {
  type: 'list';
  id: number;
  name: string;
  x: number;
  y: number;
  w: number;
  h: number;
  items: string[];
  capture?: boolean;
}

export type Box = TextBox | ListBox;

export interface MenuItem {
  id: number;
  label: string;
}

export interface Page {
  boxes: Box[];
  menu?: MenuItem[];
}

/** Same containers in the same places: contents can be updated in place without a rebuild. */
export function sameStructure(a: Page | undefined, b: Page): boolean {
  if (!a || a.boxes.length !== b.boxes.length) return false;
  if (JSON.stringify(a.menu ?? []) !== JSON.stringify(b.menu ?? [])) return false;
  return a.boxes.every((x, i) => {
    const y = b.boxes[i];
    if (x.type !== y.type || x.id !== y.id || x.name !== y.name) return false;
    if (x.x !== y.x || x.y !== y.y || x.w !== y.w || x.h !== y.h || !!x.capture !== !!y.capture) return false;
    if (x.type === 'list') return JSON.stringify(x.items) === JSON.stringify((y as ListBox).items);
    const ty = y as TextBox;
    return JSON.stringify(x.border) === JSON.stringify(ty.border) && x.padding === ty.padding;
  });
}

/** Text boxes whose content or brightness changed between two same-structure pages. */
export function changedTexts(a: Page, b: Page): TextBox[] {
  return b.boxes.filter((box, i): box is TextBox => {
    if (box.type !== 'text') return false;
    const prev = a.boxes[i] as TextBox;
    return prev.content !== box.content || (prev.brightness ?? 4) !== (box.brightness ?? 4);
  });
}

// --- rough text metrics, calibrated against the simulator font -------------

const NARROW = new Set([...'ijlI.,:;!|\'"`()[]{}/ft1r-']);
const WIDE = new Set([...'mwMW@%']);

export function glyphWidth(ch: string): number {
  if (ch === ' ') return 6;
  if (NARROW.has(ch)) return 6;
  if (WIDE.has(ch)) return 16;
  if (ch >= 'A' && ch <= 'Z') return 12;
  if (ch >= '0' && ch <= '9') return 10.5;
  return 10;
}

export function textWidth(s: string): number {
  let w = 0;
  for (const ch of s) w += glyphWidth(ch);
  return w;
}

/** Greedy word wrap with the estimated metrics; mirrors the firmware closely enough for layout. */
export function wrapLines(text: string, widthPx: number): string[] {
  const out: string[] = [];
  for (const para of text.split('\n')) {
    let line = '';
    for (const word of para.split(' ')) {
      const candidate = line ? `${line} ${word}` : word;
      if (textWidth(candidate) <= widthPx || !line) {
        line = candidate;
      } else {
        out.push(line);
        line = word;
      }
    }
    out.push(line);
  }
  return out;
}

/** Fit text into a box: wrap, and if it still overflows, cut and add "...". */
export function fitText(text: string, widthPx: number, maxLines: number): string {
  const lines = wrapLines(text, widthPx);
  if (lines.length <= maxLines) return text;
  const kept = lines.slice(0, maxLines);
  let last = kept[maxLines - 1];
  while (last.length > 0 && textWidth(last + '...') > widthPx) {
    const sp = last.lastIndexOf(' ');
    last = last.slice(0, sp > 0 ? sp : last.length - 1);
  }
  kept[maxLines - 1] = last + '...';
  return kept.join('\n');
}
