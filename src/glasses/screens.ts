import { fitText, type Brightness, type MenuItem, type Page } from './page';

/**
 * All glasses screens. Two layouts only, so moving between screens of the same
 * layout is an in-place text update (no flicker, little Bluetooth traffic):
 *
 *   HOME layout                         CARD layout
 *   +--------------------------------+  +--------------------------------+
 *   | G2 STUDY  12 due . 30 new      |  | 3 / 15  .  Zürich HB in 9 min  |  header (dim)
 *   | [ Review now              ]    |  | What does a CA sign?           |  top (question)
 *   |   Commute round                |  | +----------------------------+ |
 *   |   Record lecture               |  | | answer box                 | |  box (captures input)
 *   |                                |  | +----------------------------+ |
 *   | hold: record  2x tap: exit     |  | tap reveal                     |  footer (dim)
 *   +--------------------------------+  +--------------------------------+
 */
export const MENU: MenuItem[] = [
  { id: 1, label: 'Home' },
  { id: 2, label: 'Review now' },
  { id: 3, label: 'Commute round' },
  { id: 4, label: 'Record / stop' },
];

const X = 16;
const W = 544;
const BOX_PAD = 14;
const BOX_INNER_W = W - BOX_PAD * 2;

export interface HomeItem {
  key: 'review' | 'commute' | 'record';
  label: string;
}

export function homeScreen(o: { status: string; items: HomeItem[]; footer: string }): Page {
  return {
    menu: MENU,
    boxes: [
      { type: 'text', id: 1, name: 'status', x: X, y: 4, w: W, h: 36, content: fitText(o.status, W, 1), brightness: 3 },
      { type: 'list', id: 2, name: 'home', x: X, y: 48, w: W, h: 196, items: o.items.map((i) => i.label), capture: true },
      { type: 'text', id: 3, name: 'hint', x: X, y: 252, w: W, h: 34, content: fitText(o.footer, W, 1), brightness: 1 },
    ],
  };
}

export interface CardScreen {
  header: string;
  top: string;
  topBrightness?: Brightness;
  body: string;
  footer: string;
}

export function cardScreen(o: CardScreen): Page {
  return {
    menu: MENU,
    boxes: [
      { type: 'text', id: 1, name: 'header', x: X, y: 2, w: W, h: 34, content: fitText(o.header, W, 1), brightness: 2 },
      { type: 'text', id: 2, name: 'top', x: X, y: 38, w: W, h: 66, content: fitText(o.top, W, 2), brightness: o.topBrightness ?? 4 },
      {
        type: 'text',
        id: 3,
        name: 'box',
        x: X,
        y: 108,
        w: W,
        h: 140,
        content: fitText(o.body, BOX_INNER_W, 3),
        border: { width: 2, color: 10, radius: 10 },
        padding: BOX_PAD,
        capture: true,
      },
      { type: 'text', id: 4, name: 'footer', x: X, y: 252, w: W, h: 34, content: fitText(o.footer, W, 1), brightness: 2 },
    ],
  };
}

// --- screen builders --------------------------------------------------------

export function reviewFront(o: { header: string; front: string }): Page {
  return cardScreen({ header: o.header, top: o.front, body: '', footer: 'tap  reveal          2x tap  home' });
}

export function reviewBack(o: { header: string; front: string; back: string }): Page {
  return cardScreen({ header: o.header, top: o.front, topBrightness: 2, body: o.back, footer: '↑  knew it          ↓  again' });
}

export function recordingScreen(o: { elapsedMs: number; words: number; chunks: number; last: string; warning?: string }): Page {
  const body = o.warning ? o.warning : o.last ? `"...${o.last.slice(-110).replace(/^\S*\s/, '')}"` : 'Listening. Text appears here after the first minute.';
  return cardScreen({
    header: `● REC  ${clock(o.elapsedMs)}`,
    top: `${o.words.toLocaleString('en-US')} words  ·  ${o.chunks} min transcribed`,
    topBrightness: 3,
    body,
    footer: 'hold  stop recording',
  });
}

export function messageScreen(o: { header: string; title: string; body: string; footer?: string }): Page {
  return cardScreen({ header: o.header, top: o.title, body: o.body, footer: o.footer ?? 'tap  home' });
}

export function clock(ms: number): string {
  const s = Math.floor(ms / 1000);
  const h = Math.floor(s / 3600);
  const m = Math.floor((s % 3600) / 60);
  const sec = s % 60;
  const mm = h ? String(m).padStart(2, '0') : String(m);
  return `${h ? h + ':' : ''}${mm}:${String(sec).padStart(2, '0')}`;
}
