import { formatClock } from '../commute/plan';
import type { CommuteOffer, StudyApp } from '../core';
import type { ReviewSession, SessionResult } from '../srs/session';
import type { GlassesHost } from './host';
import type { Gesture } from './input';
import type { Page } from './page';
import { homeScreen, messageScreen, recordingScreen, reviewBack, reviewFront, type HomeItem } from './screens';

type View =
  | { k: 'home' }
  | { k: 'review'; session: ReviewSession; commute?: CommuteOffer; clock?: VirtualClock }
  | { k: 'commute'; offer?: CommuteOffer }
  | { k: 'recording' }
  | { k: 'processing'; lectureId: string; savedMs: number }
  | { k: 'message'; header: string; title: string; body: string };

/** Commute rounds can run on a sped-up clock for demos (Settings > Demo). */
class VirtualClock {
  private t0 = Date.now();
  constructor(readonly scale: number) {}
  now = () => this.t0 + (Date.now() - this.t0) * this.scale;
}

/**
 * Drives the glasses: decides what is on screen and what each gesture does.
 * Gesture map (same on temple touchpads and R1 ring):
 *   tap        select / reveal          swipe up    knew it (Good)
 *   double tap back / exit on home      swipe down  again
 *   long press start or stop recording
 */
export class GlassesController {
  private view: View = { k: 'home' };
  private homeItems: HomeItem[] = [];
  private renderSeq = 0;
  private busy = false;

  constructor(
    private app: StudyApp,
    private host: GlassesHost,
  ) {
    host.onGesture((g) => void this.onGesture(g));
    app.changed.on(() => void this.onAppChanged());
    app.recorderStatus.on(() => {
      if (this.view.k === 'recording' || this.view.k === 'home') void this.render();
    });
  }

  async start() {
    await this.render();
  }

  /** Lets the phone UI open screens on the glasses (e.g. "Start commute round"). */
  async openCommute() {
    await this.showCommute();
  }

  async openReview() {
    await this.beginReview();
  }

  get currentView(): View['k'] {
    return this.view.k;
  }

  // --- input -----------------------------------------------------------------

  private async onGesture(g: Gesture) {
    if (this.busy) return;
    this.busy = true;
    try {
      await this.handle(g);
    } catch (err) {
      console.error('[controller]', err);
      this.view = { k: 'message', header: 'G2 Study', title: 'Something went wrong', body: String((err as Error).message ?? err) };
      await this.render();
    } finally {
      this.busy = false;
    }
  }

  private async handle(g: Gesture) {
    if (g.type === 'foreground') {
      await this.app.recorder.resume();
      return this.render();
    }
    if (g.type === 'menu') return this.onMenu(g.itemId);
    if (g.type === 'holdEnd' || g.type === 'background' || g.type === 'exit') return;

    const v = this.view;
    switch (v.k) {
      case 'home':
        if (g.type === 'double') return this.host.exit();
        if (g.type === 'hold') return this.toggleRecording();
        if (g.type === 'tap') {
          const item = this.homeItems[g.listIndex ?? 0];
          if (item?.key === 'review') return this.beginReview();
          if (item?.key === 'commute') return this.showCommute();
          if (item?.key === 'record') return this.toggleRecording();
        }
        return;

      case 'review': {
        const s = v.session;
        if (g.type === 'double') return this.finishReview(true);
        if (!s.isRevealed && g.type === 'tap') {
          s.reveal();
          return this.render();
        }
        if (s.isRevealed && (g.type === 'up' || g.type === 'down')) {
          await this.app.answer(s, g.type === 'up' ? 'good' : 'again', v.clock?.scale ?? 1);
          if (s.isOver) return this.finishReview(false);
          return this.render();
        }
        return;
      }

      case 'commute':
        if (g.type === 'double') return this.goHome();
        if (g.type === 'tap' && v.offer) return this.beginCommuteRound(v.offer);
        return;

      case 'recording':
        if (g.type === 'hold') return this.toggleRecording();
        if (g.type === 'double') return this.goHome();
        return;

      case 'processing':
      case 'message':
        if (g.type === 'tap' || g.type === 'double') return this.goHome();
        if (g.type === 'hold') return this.toggleRecording();
        return;
    }
  }

  private async onMenu(id: number) {
    if (this.view.k === 'review') this.view.session.stop();
    if (id === 1) return this.goHome();
    if (id === 2) return this.beginReview();
    if (id === 3) return this.showCommute();
    if (id === 4) return this.toggleRecording();
  }

  // --- actions -----------------------------------------------------------------

  private async goHome() {
    this.view = { k: 'home' };
    await this.render();
  }

  private async toggleRecording() {
    if (this.app.recorder.current.recording) {
      const startedAt = this.app.recorder.current.elapsedMs;
      const id = await this.app.stopRecording();
      this.view = id ? { k: 'processing', lectureId: id, savedMs: startedAt } : { k: 'home' };
    } else {
      try {
        await this.app.startRecording();
        this.view = { k: 'recording' };
      } catch (err) {
        this.view = { k: 'message', header: 'Record', title: 'Microphone not available', body: (err as Error).message };
      }
    }
    await this.render();
  }

  private async beginReview() {
    const session = await this.app.startReview();
    if (!session.current) {
      const st = await this.app.stats();
      const next = st.nextDueAt ? `Next card is due ${relTime(st.nextDueAt)}.` : 'Your deck is empty.';
      this.view = {
        k: 'message',
        header: 'Review',
        title: 'All caught up',
        body: `${next} Record a lecture or import notes on your phone for new cards.`,
      };
    } else {
      this.view = { k: 'review', session };
    }
    await this.render();
  }

  private async showCommute() {
    this.view = { k: 'commute' };
    await this.render();
    const offer = await this.app.commuteOffer();
    if (this.view.k === 'commute') {
      this.view = { k: 'commute', offer };
      await this.render();
    }
  }

  private async beginCommuteRound(offer: CommuteOffer) {
    const clock = new VirtualClock(Math.max(1, this.app.settings.get().demo.timeScale));
    // Re-plan from "now" so time spent looking at the offer is accounted for.
    const session = await this.app.startReview({ limit: offer.plan.capacity, endsAt: offer.plan.endsAt, now: clock.now });
    if (!session.current) {
      this.view = { k: 'message', header: 'Commute round', title: 'Nothing to review', body: 'No cards are due and no new cards are left for today. Enjoy the view.' };
    } else {
      this.view = { k: 'review', session, commute: offer, clock };
    }
    await this.render();
  }

  private async finishReview(byUser: boolean) {
    if (this.view.k !== 'review') return;
    const { session, commute } = this.view;
    if (byUser) session.stop();
    const r = session.result();
    if (r.reviewed === 0) return this.goHome();
    const st = await this.app.stats();
    this.view = {
      k: 'message',
      header: commute ? 'Commute round' : 'Review',
      title: summaryTitle(r, commute),
      body: summaryBody(r, st.nextDueAt),
    };
    await this.render();
  }

  private async onAppChanged() {
    if (this.view.k === 'home' || this.view.k === 'processing' || this.view.k === 'recording') await this.render();
  }

  // --- rendering -----------------------------------------------------------------

  async render() {
    const seq = ++this.renderSeq;
    const page = await this.pageFor();
    if (seq !== this.renderSeq) return; // a newer render superseded this one
    await this.host.show(page);
  }

  private async pageFor(): Promise<Page> {
    const v = this.view;
    switch (v.k) {
      case 'home':
        return this.homePage();
      case 'review':
        return this.reviewPage(v.session, v.commute);
      case 'commute':
        return commutePage(v.offer, this.app.settings.get().commute.to);
      case 'recording': {
        const s = this.app.recorder.current;
        if (!s.recording) return this.homePage();
        const lecture = s.lectureId ? await this.app.store.getLecture(s.lectureId) : undefined;
        const transcript = lecture?.transcript ?? '';
        const p = s.lectureId ? this.app.progress.get(s.lectureId) : undefined;
        return recordingScreen({
          elapsedMs: s.elapsedMs,
          words: transcript ? transcript.split(/\s+/).length : 0,
          chunks: p?.done ?? 0,
          last: transcript.slice(-200),
          warning: s.stalled ? 'No audio for a few seconds. Is the phone locked or Bluetooth off? Recording resumes when audio returns.' : !this.app.transcriber() ? 'No transcription backend set, audio is saved for later.' : undefined,
        });
      }
      case 'processing': {
        const lecture = await this.app.store.getLecture(v.lectureId);
        const p = this.app.progress.get(v.lectureId);
        const mins = Math.max(1, Math.round(v.savedMs / 60000));
        if (lecture?.state === 'ready') {
          const n = (await this.app.store.listCardsByLecture(v.lectureId)).filter((c) => c.status === 'draft').length;
          return messageScreen({ header: 'Lecture saved', title: `${n} new cards ready`, body: 'Check them on your phone, then come back here to review.' });
        }
        if (lecture?.state === 'error') return messageScreen({ header: 'Lecture saved', title: 'Needs attention on phone', body: lecture.error ?? '' });
        const step = p?.phase === 'generating' ? `Making cards (${p.done}/${p.total})` : `Transcribing (${p?.done ?? 0}/${p?.total ?? '?'} min)`;
        return messageScreen({ header: 'Lecture saved', title: `${mins} min recorded`, body: `${step}... You can take the glasses off, this runs on the phone.` });
      }
      case 'message':
        return messageScreen({ header: v.header, title: v.title, body: v.body });
    }
  }

  private async homePage(): Promise<Page> {
    const st = await this.app.stats();
    const drafts = (await this.app.drafts()).length;
    const rec = this.app.recorder.current;
    const s = this.app.settings.get();
    this.homeItems = [
      { key: 'review', label: st.due + Math.min(st.newCards, s.review.newCardsPerDay) > 0 ? `Review now  ·  ${st.due} due, ${Math.min(st.newCards, s.review.newCardsPerDay)} new` : 'Review now  ·  all caught up' },
      { key: 'commute', label: `Commute round  ·  ${shortStation(s.commute.from)} → ${shortStation(s.commute.to)}` },
      { key: 'record', label: rec.recording ? '● Stop recording' : 'Record lecture' },
    ];
    const status = rec.recording
      ? `● REC ${clockOf(rec.elapsedMs)}   ·   ${st.due} due  ·  ${st.newCards} new`
      : `G2 STUDY    ${st.due} due  ·  ${st.newCards} new${drafts ? `  ·  ${drafts} to check` : ''}`;
    return homeScreen({ status, items: this.homeItems, footer: rec.recording ? 'hold  stop recording       2x tap  exit' : 'hold  record lecture       2x tap  exit' });
  }

  private reviewPage(s: ReviewSession, commute?: CommuteOffer): Page {
    const card = s.current;
    if (!card) return messageScreen({ header: 'Review', title: 'Round done', body: '' });
    let header = `Review  ·  ${s.position} / ${s.length}`;
    if (commute) {
      const left = s.minutesLeft();
      const dest = shortStation(commute.plan.connection?.to ?? this.app.settings.get().commute.to);
      header = `${s.position} / ${s.length}   ·   ${dest} ${commute.plan.connection ? formatClock(commute.plan.connection.arrival) : ''}   ·   ${left} min left`;
    }
    return s.isRevealed ? reviewBack({ header, front: card.front, back: card.back }) : reviewFront({ header, front: card.front });
  }
}

function commutePage(offer: CommuteOffer | undefined, to: string): Page {
  if (!offer) return messageScreen({ header: 'Commute round', title: `Checking trains to ${shortStation(to)}...`, body: 'transport.opendata.ch', footer: '2x tap  back' });
  const { plan } = offer;
  const c = plan.connection;
  const header = c ? `${c.products[0] ?? 'Train'}  ${formatClock(c.departure)} → ${formatClock(c.arrival)}  ${shortStation(c.to)}${c.delayMin ? `  +${c.delayMin}'` : ''}` : 'Commute round (offline estimate)';
  const title = `Ride ${plan.rideMinutes} min  ·  study ${plan.studyMinutes} min`;
  const body =
    offer.size > 0
      ? `${offer.size} cards fit (${Math.round(plan.secondsPerCard)} s each). ${offer.due} due, ${offer.fresh} new. Ends ${formatClock(plan.endsAt)}, before arrival.`
      : plan.studyMinutes <= 0
        ? 'Not enough time on this ride for a round.'
        : 'Nothing due right now. Enjoy the ride.';
  return messageScreen({ header, title, body: offer.error ? `${body} (${offer.error})` : body, footer: offer.size > 0 ? 'tap  start round          2x tap  back' : '2x tap  back' });
}

function summaryTitle(r: SessionResult, commute?: CommuteOffer): string {
  if (commute && r.endedBy === 'time') {
    const c = commute.plan.connection;
    return c ? `Arriving ${shortStation(c.to)} at ${formatClock(c.arrival)}` : 'Time is up';
  }
  return r.endedBy === 'user' ? 'Round paused' : 'Round done';
}

function summaryBody(r: SessionResult, nextDueAt?: number): string {
  const parts = [`${r.reviewed} cards: ${r.good} knew, ${r.again} again.`, `${r.avgSeconds} s per card.`];
  if (r.leftInQueue > 0) parts.push(`${r.leftInQueue} left for next time.`);
  else if (nextDueAt) parts.push(`Next due ${relTime(nextDueAt)}.`);
  return parts.join(' ');
}

export function relTime(at: number, now = Date.now()): string {
  const min = Math.round((at - now) / 60000);
  if (min <= 0) return 'now';
  if (min < 60) return `in ${min} min`;
  const h = Math.round(min / 60);
  if (h < 36) return `in ${h} h`;
  return `in ${Math.round(h / 24)} days`;
}

function shortStation(name: string): string {
  return name.replace(/\s+(HB|Hbf|Hauptbahnhof)$/i, ' HB').trim();
}

function clockOf(ms: number): string {
  const s = Math.floor(ms / 1000);
  return `${Math.floor(s / 60)}:${String(s % 60).padStart(2, '0')}`;
}
