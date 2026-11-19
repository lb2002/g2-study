/**
 * Normalises Even Hub events into a small set of gestures.
 *
 * Observed in evenhub-simulator 0.9.5 (and consistent with the SDK enum):
 *   tap on a text page   -> sysEvent  { eventSource: 1 }            (eventType omitted = CLICK 0)
 *   swipe up / down      -> textEvent { eventType: 1 | 2 }          (SCROLL_TOP / SCROLL_BOTTOM)
 *   double tap           -> sysEvent  { eventType: 3 }
 *   long press / release -> sysEvent  { eventType: 9 | 10 }
 *   tap on a list        -> listEvent { currentSelectItemIndex: n }  (eventType omitted)
 *   list up/down         -> handled by the firmware, no event
 * Protobuf drops zero values, so a missing eventType means CLICK.
 */
export type Gesture =
  | { type: 'tap'; listIndex?: number; listName?: string }
  | { type: 'double' }
  | { type: 'up' }
  | { type: 'down' }
  | { type: 'hold' }
  | { type: 'holdEnd' }
  | { type: 'foreground' }
  | { type: 'background' }
  | { type: 'exit' }
  | { type: 'menu'; itemId: number };

interface RawEvent {
  listEvent?: { eventType?: number; currentSelectItemIndex?: number; containerID?: number; containerName?: string };
  textEvent?: { eventType?: number; containerID?: number; containerName?: string };
  sysEvent?: { eventType?: number; eventSource?: number };
  menuItemClickEvent?: { itemID?: number };
  audioEvent?: unknown;
}

export function toGesture(e: RawEvent): Gesture | null {
  if (e.audioEvent) return null;
  if (e.menuItemClickEvent?.itemID) return { type: 'menu', itemId: e.menuItemClickEvent.itemID };
  if (e.listEvent) {
    const t = e.listEvent.eventType ?? 0;
    if (t === 0) return { type: 'tap', listIndex: e.listEvent.currentSelectItemIndex ?? 0, listName: e.listEvent.containerName };
    return fromType(t);
  }
  const src = e.textEvent ?? e.sysEvent;
  if (!src) return null;
  return fromType(src.eventType ?? 0);
}

function fromType(t: number): Gesture | null {
  switch (t) {
    case 0:
      return { type: 'tap' };
    case 1:
      return { type: 'up' };
    case 2:
      return { type: 'down' };
    case 3:
      return { type: 'double' };
    case 4:
      return { type: 'foreground' };
    case 5:
      return { type: 'background' };
    case 6:
    case 7:
      return { type: 'exit' };
    case 9:
      return { type: 'hold' };
    case 10:
      return { type: 'holdEnd' };
    default:
      return null; // IMU and future types
  }
}

/** Drops an identical gesture repeated within `windowMs` (some hosts report a tap on two channels). */
export function dedupeGestures(windowMs = 60) {
  let last: { key: string; at: number } | null = null;
  return (g: Gesture, now = Date.now()): boolean => {
    const key = JSON.stringify(g);
    const dup = !!last && last.key === key && now - last.at < windowMs;
    last = { key, at: now };
    return !dup;
  };
}
