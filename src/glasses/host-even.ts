import {
  AudioInputSource,
  CreateStartUpPageContainer,
  ListContainerProperty,
  ListItemContainerProperty,
  MenuContainerProperty,
  MenuItemProperty,
  RebuildPageContainer,
  StartUpPageCreateResult,
  TextContainerProperty,
  TextContainerUpgrade,
  waitForEvenAppBridge,
  type EvenAppBridge,
} from '@evenrealities/even_hub_sdk';
import type { MicSource } from '../settings';
import { Emitter, type GlassesHost } from './host';
import { dedupeGestures, toGesture, type Gesture } from './input';
import { changedTexts, sameStructure, type Page } from './page';

/** True when running inside the Even Realities app (or the official simulator). */
export function hasEvenHost(): boolean {
  return typeof window !== 'undefined' && 'flutter_inappwebview' in window;
}

export class EvenHost implements GlassesHost {
  readonly kind = 'even' as const;
  private current?: Page;
  private created = false;
  private queue: Promise<void> = Promise.resolve();
  private gestures = new Emitter<Gesture>();
  private audio = new Emitter<Uint8Array>();
  private micOn = false;

  private constructor(private bridge: EvenAppBridge) {
    const keep = dedupeGestures();
    bridge.onEvenHubEvent((e) => {
      if (e.audioEvent) {
        const pcm = e.audioEvent.audioPcm;
        if (pcm?.length) this.audio.emit(pcm instanceof Uint8Array ? pcm : new Uint8Array(pcm as ArrayLike<number>));
        return;
      }
      const g = toGesture(e);
      if (g && keep(g)) this.gestures.emit(g);
    });
  }

  static async connect(timeoutMs = 4000): Promise<EvenHost> {
    const bridge = await Promise.race([
      waitForEvenAppBridge(),
      new Promise<never>((_, rej) => setTimeout(() => rej(new Error('Even app bridge not ready')), timeoutMs)),
    ]);
    return new EvenHost(bridge);
  }

  /** Serialise display calls: the bridge does not like overlapping page updates. */
  show(page: Page): Promise<void> {
    this.queue = this.queue.then(() => this.apply(page)).catch((err) => console.error('[glasses]', err));
    return this.queue;
  }

  private async apply(page: Page): Promise<void> {
    if (this.created && this.current && sameStructure(this.current, page)) {
      for (const box of changedTexts(this.current, page)) {
        await this.bridge.textContainerUpgrade(
          new TextContainerUpgrade({
            containerID: box.id,
            containerName: box.name,
            content: box.content || ' ',
            textColor: box.brightness ?? 4,
          }),
        );
      }
      this.current = page;
      return;
    }
    const payload = toPayload(page);
    if (!this.created) {
      const res = await this.bridge.createStartUpPageContainer(new CreateStartUpPageContainer(payload));
      if (res !== StartUpPageCreateResult.success) throw new Error(`createStartUpPageContainer failed: ${res}`);
      this.created = true;
    } else {
      const ok = await this.bridge.rebuildPageContainer(new RebuildPageContainer(payload));
      if (!ok) throw new Error('rebuildPageContainer failed');
    }
    this.current = page;
  }

  onGesture(cb: (g: Gesture) => void) {
    return this.gestures.on(cb);
  }

  onAudio(cb: (pcm: Uint8Array) => void) {
    return this.audio.on(cb);
  }

  async setMic(on: boolean, source: MicSource): Promise<boolean> {
    if (!on && !this.micOn) return true;
    const ok = on
      ? await this.bridge.audioControl(true, source === 'phone' ? AudioInputSource.Phone : AudioInputSource.Glasses)
      : await this.bridge.audioControl(false);
    if (ok) this.micOn = on;
    return ok;
  }

  async exit(): Promise<void> {
    await this.bridge.shutDownPageContainer(1);
  }
}

function toPayload(page: Page) {
  const textObject: TextContainerProperty[] = [];
  const listObject: ListContainerProperty[] = [];
  for (const b of page.boxes) {
    const common = {
      containerID: b.id,
      containerName: b.name,
      xPosition: b.x,
      yPosition: b.y,
      width: b.w,
      height: b.h,
      isEventCapture: b.capture ? 1 : 0,
    };
    if (b.type === 'text') {
      textObject.push(
        new TextContainerProperty({
          ...common,
          content: b.content || ' ',
          textColor: b.brightness ?? 4,
          borderWidth: b.border?.width ?? 0,
          borderColor: b.border?.color ?? 0,
          borderRadius: b.border?.radius ?? 0,
          paddingLength: b.padding ?? 0,
        }),
      );
    } else {
      listObject.push(
        new ListContainerProperty({
          ...common,
          borderWidth: 0,
          itemContainer: new ListItemContainerProperty({
            itemCount: b.items.length,
            itemWidth: b.w,
            isItemSelectBorderEn: 1,
            itemName: b.items.map((s) => s.slice(0, 60)),
          }),
        }),
      );
    }
  }
  return {
    containerTotalNum: page.boxes.length,
    textObject,
    listObject,
    menuObject: page.menu?.length
      ? new MenuContainerProperty({ menuItems: page.menu.map((m) => new MenuItemProperty({ itemID: m.id, itemName: m.label })) })
      : undefined,
  };
}
