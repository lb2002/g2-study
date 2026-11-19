import { describe, expect, it } from 'vitest';
import { dedupeGestures, toGesture } from '../src/glasses/input';
import { changedTexts, fitText, sameStructure, wrapLines } from '../src/glasses/page';
import { cardScreen, clock, homeScreen, reviewBack, reviewFront } from '../src/glasses/screens';

describe('toGesture (payloads captured from evenhub-simulator 0.9.5)', () => {
  it.each([
    [{ sysEvent: { eventSource: 1 } }, { type: 'tap' }],
    [{ textEvent: { containerID: 2, containerName: 'card', eventType: 1 } }, { type: 'up' }],
    [{ textEvent: { containerID: 2, containerName: 'card', eventType: 2 } }, { type: 'down' }],
    [{ sysEvent: { eventType: 3, eventSource: 1 } }, { type: 'double' }],
    [{ sysEvent: { eventType: 9 } }, { type: 'hold' }],
    [{ sysEvent: { eventType: 10 } }, { type: 'holdEnd' }],
    [{ sysEvent: { eventType: 4 } }, { type: 'foreground' }],
    [{ listEvent: { containerID: 2, containerName: 'home', currentSelectItemIndex: 2 } }, { type: 'tap', listIndex: 2, listName: 'home' }],
    [{ menuItemClickEvent: { itemID: 3 } }, { type: 'menu', itemId: 3 }],
  ])('%j -> %j', (raw, expected) => {
    expect(toGesture(raw)).toEqual(expected);
  });

  it('ignores audio and IMU events', () => {
    expect(toGesture({ audioEvent: {} })).toBeNull();
    expect(toGesture({ sysEvent: { eventType: 8 } })).toBeNull();
  });

  it('dedupes a gesture reported twice in quick succession', () => {
    const keep = dedupeGestures(60);
    expect(keep({ type: 'tap' }, 0)).toBe(true);
    expect(keep({ type: 'tap' }, 20)).toBe(false);
    expect(keep({ type: 'tap' }, 200)).toBe(true);
    expect(keep({ type: 'up' }, 210)).toBe(true);
  });
});

describe('text fitting', () => {
  it('wraps on words', () => {
    const lines = wrapLines('What does a certificate authority sign in an X.509 certificate?', 300);
    expect(lines.length).toBeGreaterThan(1);
    lines.forEach((l) => expect(l.startsWith(' ')).toBe(false));
  });

  it('cuts with an ellipsis when text would overflow the box', () => {
    const long = 'word '.repeat(200).trim();
    const out = fitText(long, 516, 3);
    expect(wrapLines(out, 516).length).toBeLessThanOrEqual(3);
    expect(out.endsWith('...')).toBe(true);
    expect(fitText('short', 516, 3)).toBe('short');
  });

  it('a max-length card fits its boxes without cutting', () => {
    const front = 'Which property keeps old sessions safe if a key leaks later?'; // 60 chars
    const back = 'Forward secrecy: each session uses an ephemeral Diffie-Hellman key, so a stolen long-term key reveals nothing old.'; // < 120
    const page = reviewBack({ header: 'h', front, back });
    const [, top, box] = page.boxes as { content: string }[];
    expect(top.content).toBe(front);
    expect(box.content).toBe(back);
  });
});

describe('screens', () => {
  it('front and back share a structure, so revealing is an in-place update', () => {
    const front = reviewFront({ header: '1 / 3', front: 'Q?' });
    const back = reviewBack({ header: '1 / 3', front: 'Q?', back: 'A' });
    expect(sameStructure(front, back)).toBe(true);
    expect(changedTexts(front, back).map((b) => b.name)).toEqual(['top', 'box', 'footer']);
  });

  it('home and card layouts differ, so switching rebuilds', () => {
    const home = homeScreen({ status: 's', items: [{ key: 'review', label: 'Review' }], footer: 'f' });
    expect(sameStructure(home, cardScreen({ header: '', top: '', body: '', footer: '' }))).toBe(false);
  });

  it('a changed list item forces a rebuild (lists cannot be updated in place)', () => {
    const a = homeScreen({ status: 's', items: [{ key: 'record', label: 'Record lecture' }], footer: 'f' });
    const b = homeScreen({ status: 's', items: [{ key: 'record', label: '● Stop recording' }], footer: 'f' });
    expect(sameStructure(a, b)).toBe(false);
  });

  it('every page has exactly one event-capturing container and stays inside the display', () => {
    const pages = [reviewFront({ header: 'h', front: 'f' }), homeScreen({ status: 's', items: [{ key: 'review', label: 'r' }], footer: 'f' })];
    for (const p of pages) {
      expect(p.boxes.filter((b) => b.capture)).toHaveLength(1);
      for (const b of p.boxes) {
        expect(b.x + b.w).toBeLessThanOrEqual(576);
        expect(b.y + b.h).toBeLessThanOrEqual(288);
      }
    }
  });

  it('formats clocks', () => {
    expect(clock(65_000)).toBe('1:05');
    expect(clock(3_725_000)).toBe('1:02:05');
  });
});
