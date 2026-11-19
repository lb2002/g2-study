import { isOverLimit } from '../ai/cards';
import { formatClock } from '../commute/plan';
import type { CommuteOffer, StudyApp } from '../core';
import type { GlassesController } from '../glasses/controller';
import { relTime } from '../glasses/controller';
import type { PreviewHost } from '../glasses/host-preview';
import { isDue, isNew } from '../srs/scheduler';
import { BACK_MAX, FRONT_MAX, type Lecture, type StudyCard } from '../types';
import { fmtDate, fmtDuration, h, icon, isEditing, replace, toast } from './dom';
import { renderSettings } from './settings-view';
import sampleLecture from '../../samples/public-key-crypto.txt?raw';

type Tab = 'study' | 'capture' | 'cards' | 'settings';

const TAB_KEY = 'g2study.tab';

export class PhoneUI {
  private tab: Tab = (safeGet(TAB_KEY) as Tab) || 'study';
  private main = h('main', { class: 'content' });
  private nav = h('nav', { class: 'tabbar' });
  private pendingRender = false;
  private commute?: CommuteOffer;
  private commuteLoading = false;
  private commuteStale = false;
  private openTranscript = new Set<string>();
  private cardFilter = '';

  constructor(
    private root: HTMLElement,
    private app: StudyApp,
    private glasses: GlassesController,
    private preview?: PreviewHost,
  ) {}

  mount() {
    const header = h(
      'header',
      { class: 'topbar' },
      h('div', { class: 'brand' }, h('span', { class: 'logo' }, icon('glasses', 20)), h('span', null, 'G2 Study')),
      h('span', { class: `pill ${this.app.host.kind}` }, h('span', { class: 'dot' }), this.app.host.kind === 'even' ? 'Glasses connected' : 'Browser preview'),
    );
    const shell = h('div', { class: 'shell' }, header, this.preview ? this.previewPanel() : null, this.main);
    replace(this.root, shell, this.nav);
    this.renderNav();
    this.render();

    this.app.changed.on(() => {
      this.commuteStale = true;
      this.scheduleRender();
    });
    this.app.recorderStatus.on(() => this.updateRecordingLive());
    this.root.addEventListener('focusout', () => {
      if (this.pendingRender) setTimeout(() => this.scheduleRender(), 0);
    });
  }

  // --- shell -------------------------------------------------------------------

  private previewPanel() {
    const canvas = document.getElementById('glasses-canvas') as HTMLCanvasElement;
    canvas.hidden = false;
    const btn = (label: string, g: Parameters<PreviewHost['press']>[0], title: string) =>
      h('button', { class: 'gbtn', title, onclick: () => this.preview!.press(g) }, label);
    const hold = h('button', { class: 'gbtn', title: 'Long press (or hold H)' }, 'hold');
    hold.addEventListener('pointerdown', () => this.preview!.press('hold'));
    hold.addEventListener('pointerup', () => this.preview!.press('holdEnd'));
    return h(
      'section',
      { class: 'glasses-preview' },
      h('div', { class: 'lens' }, canvas),
      h('div', { class: 'gcontrols' }, btn('↑', 'up', 'Swipe up (Arrow Up)'), btn('↓', 'down', 'Swipe down (Arrow Down)'), btn('tap', 'tap', 'Tap (Enter)'), btn('2× tap', 'double', 'Double tap (Esc)'), hold),
      h('p', { class: 'hint' }, 'Preview of the glasses display. Keys: ↑ ↓, Enter = tap, Esc = double tap, hold H = long press. Use the official simulator for an accurate render.'),
    );
  }

  private renderNav() {
    const items: [Tab, string, string][] = [
      ['study', 'Study', 'study'],
      ['capture', 'Capture', 'mic'],
      ['cards', 'Cards', 'cards'],
      ['settings', 'Settings', 'settings'],
    ];
    void this.app.drafts().then((drafts) => {
      replace(
        this.nav,
        items.map(([id, label, ic]) =>
          h(
            'button',
            { class: `tab ${this.tab === id ? 'active' : ''}`, onclick: () => this.go(id), 'aria-current': this.tab === id ? 'page' : null },
            h('span', { class: 'tab-icon' }, icon(ic, 22), id === 'cards' && drafts.length ? h('span', { class: 'badge' }, drafts.length) : null),
            h('span', null, label),
          ),
        ),
      );
    });
  }

  go(tab: Tab) {
    this.tab = tab;
    safeSet(TAB_KEY, tab);
    this.renderNav();
    this.render();
    window.scrollTo({ top: 0 });
  }

  private scheduleRender() {
    // Never rebuild the DOM under the user's cursor; catch up once they leave the field.
    if (isEditing(this.main)) {
      this.pendingRender = true;
      return;
    }
    this.pendingRender = false;
    this.renderNav();
    this.render();
  }

  private async render() {
    const tab = this.tab;
    let view: Node;
    if (tab === 'study') view = await this.studyView();
    else if (tab === 'capture') view = await this.captureView();
    else if (tab === 'cards') view = await this.cardsView();
    else view = renderSettings(this.app);
    if (tab === this.tab) replace(this.main, view);
  }

  // --- study ---------------------------------------------------------------------

  private async studyView() {
    const st = await this.app.stats();
    const s = this.app.settings.get();
    const drafts = (await this.app.drafts()).length;
    const reviews = await this.app.store.recentReviews(500);
    const week = reviews.filter((r) => r.at > Date.now() - 7 * 86400000);
    const newToday = Math.min(st.newCards, s.review.newCardsPerDay);

    // The deck changed since the last offer: recount (the timetable itself is cached in the core).
    if ((!this.commute || this.commuteStale) && !this.commuteLoading) {
      this.commuteStale = false;
      void this.loadCommute();
    }

    return h(
      'div',
      { class: 'stack' },
      h(
        'section',
        { class: 'stats' },
        stat(st.due, 'due now', 'accent'),
        stat(newToday, 'new today'),
        stat(st.total, 'in deck'),
      ),
      this.app.recorder.current.recording
        ? h('button', { class: 'notice rec', onclick: () => this.go('capture') }, h('span', { class: 'rec-dot' }), h('span', null, 'Recording a lecture'), icon('chevron'))
        : null,
      drafts
        ? h('button', { class: 'notice', onclick: () => this.go('cards') }, icon('sparkle'), h('span', null, `${drafts} new card${drafts === 1 ? '' : 's'} waiting for your check`), icon('chevron'))
        : null,
      h(
        'section',
        { class: 'card' },
        h('div', { class: 'card-head' }, h('h2', null, 'Review'), h('span', { class: 'muted' }, st.nextDueAt && !st.due ? `next ${relTime(st.nextDueAt)}` : '')),
        h('p', { class: 'muted' }, st.due + newToday ? `${st.due} due and ${newToday} new cards. Tap to reveal, swipe up if you knew it, down if not.` : 'Nothing due. Capture a lecture to get new cards.'),
        h(
          'button',
          { class: 'primary', disabled: st.due + newToday === 0, onclick: async () => { await this.glasses.openReview(); toast('Review started on the glasses'); } },
          icon('glasses'),
          'Start review on glasses',
        ),
      ),
      this.commuteCard(),
      h(
        'section',
        { class: 'card subtle' },
        h('h2', null, 'This week'),
        h(
          'div',
          { class: 'kv' },
          h('span', null, 'Reviews'),
          h('b', null, week.length),
          h('span', null, 'Recall rate'),
          h('b', null, week.length ? `${Math.round((week.filter((r) => r.rating === 'good').length / week.length) * 100)} %` : '-'),
          h('span', null, 'Time per card'),
          h('b', null, week.length ? `${(week.reduce((n, r) => n + r.durationMs, 0) / week.length / 1000).toFixed(1)} s` : '-'),
        ),
      ),
    );
  }

  private async loadCommute(force = false) {
    if (this.commuteLoading && !force) return;
    this.commuteLoading = true;
    try {
      this.commute = await this.app.commuteOffer(Date.now(), force);
    } finally {
      this.commuteLoading = false;
      if (this.tab === 'study') this.scheduleRender();
    }
  }

  private commuteCard() {
    const s = this.app.settings.get().commute;
    const o = this.commute;
    const c = o?.plan.connection;
    const route = h('div', { class: 'route' }, h('span', null, s.from), icon('arrow', 16), h('span', null, s.to));
    let body: Node;
    if (!o) body = h('p', { class: 'muted' }, 'Checking the timetable...');
    else
      body = h(
        'div',
        null,
        c
          ? h(
              'div',
              { class: 'train' },
              h('span', { class: 'line' }, c.products[0] ?? 'Train'),
              h('b', null, `${formatClock(c.departure)} → ${formatClock(c.arrival)}`),
              h('span', { class: 'muted' }, c.platform ? `Pl. ${c.platform}` : ''),
              c.delayMin ? h('span', { class: 'delay' }, `+${c.delayMin}'`) : null,
            )
          : null,
        h(
          'div',
          { class: 'budget' },
          h('div', null, h('b', null, `${o.plan.studyMinutes} min`), h('span', null, 'to study')),
          h('div', null, h('b', null, o.size), h('span', null, 'cards fit')),
          h('div', null, h('b', null, `${Math.round(o.plan.secondsPerCard)} s`), h('span', null, 'per card')),
        ),
        h('p', { class: 'muted small' }, o.error ?? `Round ends ${formatClock(o.plan.endsAt)}, ${this.app.settings.get().commute.bufferMin} min before arrival. Due cards first, then new ones.`),
      );
    return h(
      'section',
      { class: 'card' },
      h(
        'div',
        { class: 'card-head' },
        h('h2', null, icon('train'), 'Commute round'),
        h('button', { class: 'icon-btn', title: 'Refresh', onclick: () => { this.commute = undefined; void this.loadCommute(true); this.render(); } }, icon('refresh')),
      ),
      route,
      body,
      h(
        'button',
        { class: 'primary', disabled: !o || o.size === 0, onclick: async () => { await this.glasses.openCommute(); toast('Commute round sent to the glasses'); } },
        icon('glasses'),
        'Send round to glasses',
      ),
    );
  }

  // --- capture ---------------------------------------------------------------------

  private recordBox?: HTMLElement;

  private async captureView() {
    const lectures = await this.app.store.listLectures();
    this.recordBox = h('section', { class: 'card record' });
    this.updateRecordingLive();

    let importMode: 'text' | 'audio' | 'file' = 'text';
    const title = h('input', { type: 'text', placeholder: 'Title, e.g. Crypto L5: Public keys', maxlength: 80 });
    const text = h('textarea', { rows: 7, placeholder: 'Paste a transcript, your notes or text copied from the lecture PDF...' });
    const counter = h('span', { class: 'muted small' }, '0 words');
    text.addEventListener('input', () => (counter.textContent = `${text.value.trim() ? text.value.trim().split(/\s+/).length : 0} words`));
    const audioInput = h('input', { type: 'file', accept: 'audio/*,.m4a,.mp3,.wav,.ogg,.webm', class: 'file' });
    const textFileInput = h('input', { type: 'file', accept: '.txt,.md,.vtt,.srt,text/plain', class: 'file' });
    const pane = h('div');
    const seg = h('div', { class: 'segmented', role: 'tablist' });

    const showMode = () => {
      replace(
        seg,
        (
          [
            ['text', 'Paste text', 'text'],
            ['audio', 'Audio file', 'upload'],
            ['file', 'Text file', 'file'],
          ] as const
        ).map(([m, label, ic]) =>
          h('button', { class: importMode === m ? 'on' : '', role: 'tab', onclick: () => { importMode = m; showMode(); } }, icon(ic, 16), label),
        ),
      );
      if (importMode === 'text') replace(pane, title, text, h('div', { class: 'row between' }, counter, h('button', { class: 'link', onclick: () => { title.value = 'Sample: Public-key cryptography'; text.value = sampleLecture; text.dispatchEvent(new Event('input')); } }, 'Load sample lecture')));
      else if (importMode === 'audio') replace(pane, h('p', { class: 'muted small' }, 'A recording from your phone or laptop. It is cut into 1 min pieces and sent to your transcription backend.'), audioInput);
      else replace(pane, h('p', { class: 'muted small' }, 'Plain text, Markdown or subtitles (.vtt/.srt).'), title, textFileInput);
    };
    showMode();

    const go = h('button', { class: 'primary' }, icon('sparkle'), 'Make cards');
    go.addEventListener('click', async () => {
      try {
        if (importMode === 'audio') {
          const f = audioInput.files?.[0];
          if (!f) return toast('Choose an audio file first', 'error');
          if (!this.app.transcriber()) return toast('Set up transcription in Settings first', 'error');
          await this.app.importAudio(f);
        } else if (importMode === 'file') {
          const f = textFileInput.files?.[0];
          if (!f) return toast('Choose a text file first', 'error');
          await this.app.importText(title.value.trim() || f.name.replace(/\.[^.]+$/, ''), stripSubtitles(await f.text()));
        } else {
          if (text.value.trim().split(/\s+/).length < 30) return toast('Paste a bit more text (30+ words)', 'error');
          await this.app.importText(title.value.trim(), text.value);
          text.value = '';
          title.value = '';
        }
        toast('Working on it, cards will show up under Cards');
      } catch (err) {
        toast((err as Error).message, 'error');
      }
    });

    return h(
      'div',
      { class: 'stack' },
      this.recordBox,
      h('section', { class: 'card' }, h('h2', null, 'Import'), seg, pane, go),
      h(
        'section',
        { class: 'stack-tight' },
        h('h3', { class: 'section-title' }, 'Lectures'),
        lectures.length ? lectures.map((l) => this.lectureRow(l)) : h('p', { class: 'muted empty' }, 'Nothing captured yet.'),
      ),
    );
  }

  private updateRecordingLive() {
    const box = this.recordBox;
    if (!box || this.tab !== 'capture') return;
    const s = this.app.recorder.current;
    const settings = this.app.settings.get();
    const noBackend = !this.app.transcriber();
    if (s.recording) {
      const p = s.lectureId ? this.app.progress.get(s.lectureId) : undefined;
      replace(
        box,
        h('div', { class: 'rec-live' }, h('span', { class: 'rec-dot' }), h('b', null, 'Recording'), h('span', { class: 'timer' }, clock(s.elapsedMs))),
        h('p', { class: 'muted small' }, `${p?.done ?? 0} of ${p?.total ?? 0} minutes transcribed · ${s.diagnostics.gaps.length} audio gaps`),
        s.stalled ? h('p', { class: 'warn' }, icon('alert', 16), 'No audio for a few seconds. Keep the app open and Bluetooth on.') : null,
        this.app.lastTranscriptTail ? h('blockquote', null, '…' + this.app.lastTranscriptTail.slice(-160)) : null,
        h('button', { class: 'danger', onclick: () => void this.app.stopRecording() }, 'Stop and make cards'),
      );
      return;
    }
    replace(
      box,
      h('div', { class: 'card-head' }, h('h2', null, 'Record a lecture')),
      h('p', { class: 'muted' }, 'Long-press the temple (or ring) to start and stop. Audio goes to your transcription backend in 1 min pieces; cards are made when you stop.'),
      h(
        'div',
        { class: 'segmented small' },
        (['glasses', 'phone'] as const).map((m) =>
          h('button', { class: settings.recording.mic === m ? 'on' : '', onclick: () => { this.app.settings.update((d) => (d.recording.mic = m)); this.updateRecordingLive(); } }, m === 'glasses' ? 'Glasses mic' : 'Phone mic'),
        ),
      ),
      noBackend ? h('p', { class: 'warn' }, icon('alert', 16), 'No transcription backend set. Audio will be saved, add one in Settings to turn it into text.') : null,
      h('button', { class: 'record-btn', onclick: async () => { try { await this.app.startRecording(); await this.glasses.render(); } catch (e) { toast((e as Error).message, 'error'); } } }, h('span', { class: 'rec-dot' }), 'Start recording'),
      h('p', { class: 'consent' }, 'Ask the lecturer before recording. Many universities require consent.'),
    );
  }

  private lectureRow(l: Lecture) {
    const p = this.app.progress.get(l.id);
    const badge =
      l.state === 'error'
        ? h('span', { class: 'badge-state error' }, 'Needs attention')
        : l.state === 'ready'
          ? h('span', { class: 'badge-state ok' }, 'Done')
          : h('span', { class: 'badge-state busy' }, h('span', { class: 'spinner' }), progressLabel(l, p));
    const sourceLabel: Record<Lecture['source'], string> = {
      'glasses-mic': 'Glasses mic',
      'phone-mic': 'Phone mic',
      'browser-mic': 'Browser mic',
      'audio-file': 'Audio file',
      text: 'Text',
    };
    const open = this.openTranscript.has(l.id);
    const words = l.transcript ? l.transcript.split(/\s+/).length : 0;
    return h(
      'article',
      { class: 'lecture' },
      h(
        'div',
        { class: 'row between' },
        h('div', null, h('b', null, l.title), h('div', { class: 'muted small' }, `${fmtDate(l.createdAt)} · ${sourceLabel[l.source]}${l.durationMs ? ` · ${fmtDuration(l.durationMs)}` : ''} · ${words} words`)),
        badge,
      ),
      l.error ? h('p', { class: 'error-text' }, l.error) : null,
      l.diagnostics && (l.diagnostics.gaps.length || l.source === 'glasses-mic')
        ? h('p', { class: 'muted small' }, `Mic: ${l.diagnostics.framesReceived} frames, ${l.diagnostics.gaps.length} gaps (${fmtDuration(l.diagnostics.gaps.reduce((n, g) => n + g.lengthMs, 0))} lost)`)
        : null,
      open && l.transcript ? h('div', { class: 'transcript' }, l.transcript) : null,
      h(
        'div',
        { class: 'row gap' },
        l.transcript ? h('button', { class: 'link', onclick: () => { open ? this.openTranscript.delete(l.id) : this.openTranscript.add(l.id); this.render(); } }, open ? 'Hide transcript' : 'Show transcript') : null,
        l.state === 'error' ? h('button', { class: 'link', onclick: () => void this.app.retry(l.id) }, 'Retry') : null,
        l.state === 'ready' && l.transcript ? h('button', { class: 'link', onclick: () => void this.app.generateFor(l.id) }, 'Make more cards') : null,
        h('button', { class: 'link danger-text', onclick: () => { if (confirm(`Delete "${l.title}" and its cards?`)) void this.app.deleteLecture(l.id); } }, 'Delete'),
      ),
    );
  }

  // --- cards ---------------------------------------------------------------------

  private async cardsView() {
    const cards = await this.app.store.listCards();
    const lectures = new Map((await this.app.store.listLectures()).map((l) => [l.id, l]));
    const drafts = cards.filter((c) => c.status === 'draft').sort((a, b) => a.createdAt - b.createdAt);
    const active = cards.filter((c) => c.status === 'active');
    const q = this.cardFilter.toLowerCase();
    const shown = active.filter((c) => !q || c.front.toLowerCase().includes(q) || c.back.toLowerCase().includes(q)).sort((a, b) => a.srs.due - b.srs.due);

    const byLecture = new Map<string, StudyCard[]>();
    drafts.forEach((d) => byLecture.set(d.lectureId, [...(byLecture.get(d.lectureId) ?? []), d]));

    const search = h('input', { type: 'search', placeholder: `Search ${active.length} cards`, value: this.cardFilter });
    search.addEventListener('input', () => {
      this.cardFilter = search.value;
      const list = document.getElementById('deck-list');
      if (list) replace(list, this.deckRows(active.filter((c) => !this.cardFilter || (c.front + ' ' + c.back).toLowerCase().includes(this.cardFilter.toLowerCase()))));
    });

    return h(
      'div',
      { class: 'stack' },
      drafts.length
        ? h(
            'section',
            { class: 'stack-tight' },
            h(
              'div',
              { class: 'row between' },
              h('h3', { class: 'section-title' }, `To check (${drafts.length})`),
              h('button', { class: 'primary small', onclick: async () => { const ok = drafts.filter((d) => !isOverLimit(d)); await this.app.acceptCards(ok.map((d) => d.id)); toast(`${ok.length} cards added to your deck${ok.length < drafts.length ? `, ${drafts.length - ok.length} too long to fit` : ''}`); } }, icon('check', 16), 'Add all to deck'),
            ),
            h('p', { class: 'muted small' }, `Edit or delete before they go into the deck. Fronts up to ${FRONT_MAX} and backs up to ${BACK_MAX} characters fit the glasses.`),
            [...byLecture.entries()].map(([lid, list]) => h('div', { class: 'stack-tight' }, h('div', { class: 'group-title' }, lectures.get(lid)?.title ?? 'Unknown lecture'), list.map((c) => this.draftEditor(c)))),
          )
        : null,
      h(
        'section',
        { class: 'stack-tight' },
        h('h3', { class: 'section-title' }, 'Deck'),
        active.length ? search : null,
        h('div', { id: 'deck-list', class: 'stack-tight' }, active.length ? this.deckRows(shown) : h('p', { class: 'muted empty' }, 'No cards in the deck yet. Capture a lecture or paste notes under Capture.')),
      ),
    );
  }

  private draftEditor(c: StudyCard) {
    const front = h('textarea', { rows: 2, class: 'front-in', value: c.front });
    const back = h('textarea', { rows: 3, value: c.back });
    const fc = h('span', { class: 'count' });
    const bc = h('span', { class: 'count' });
    const keep = h('button', { class: 'primary small', title: 'Add to deck' }, icon('check', 16), 'Keep');
    const sync = () => {
      fc.textContent = `${front.value.length}/${FRONT_MAX}`;
      bc.textContent = `${back.value.length}/${BACK_MAX}`;
      fc.classList.toggle('over', front.value.length > FRONT_MAX);
      bc.classList.toggle('over', back.value.length > BACK_MAX);
      keep.disabled = front.value.length > FRONT_MAX || back.value.length > BACK_MAX || !front.value.trim() || !back.value.trim();
    };
    sync();
    const save = () => void this.app.store.putCard({ ...c, front: front.value.trim(), back: back.value.trim() });
    front.addEventListener('input', sync);
    back.addEventListener('input', sync);
    front.addEventListener('change', save);
    back.addEventListener('change', save);
    keep.addEventListener('click', async () => {
      await this.app.store.putCard({ ...c, front: front.value.trim(), back: back.value.trim() });
      await this.app.acceptCards([c.id]);
    });
    return h(
      'article',
      { class: 'draft' },
      h('label', null, h('span', null, 'Front'), fc),
      front,
      h('label', null, h('span', null, 'Back'), bc),
      back,
      c.sourceSnippet ? h('details', null, h('summary', null, 'Source'), h('q', null, c.sourceSnippet)) : null,
      h('div', { class: 'row between' }, h('button', { class: 'icon-btn', title: 'Delete', onclick: () => void this.app.deleteCard(c.id) }, icon('trash')), keep),
    );
  }

  private deckRows(cards: StudyCard[]) {
    if (!cards.length) return [h('p', { class: 'muted empty' }, 'No matches.')];
    return cards.slice(0, 200).map((c) =>
      h(
        'details',
        { class: 'deck-card' },
        h('summary', null, h('span', { class: 'front' }, c.front), h('span', { class: `due ${isDue(c) ? 'now' : ''}` }, isNew(c) ? 'new' : isDue(c) ? 'due' : relTime(c.srs.due).replace('in ', ''))),
        h('p', null, c.back),
        h(
          'div',
          { class: 'row between' },
          h('span', { class: 'muted small' }, `${c.srs.reps} reviews · ${c.srs.lapses} lapses${c.srs.stability ? ` · stability ${c.srs.stability.toFixed(1)} d` : ''}`),
          h('button', { class: 'icon-btn', title: 'Delete card', onclick: () => { if (confirm('Delete this card?')) void this.app.deleteCard(c.id); } }, icon('trash', 16)),
        ),
      ),
    );
  }
}

function stat(value: number, label: string, cls = '') {
  return h('div', { class: `stat ${cls}` }, h('b', null, value), h('span', null, label));
}

function progressLabel(l: Lecture, p?: { phase: string; done: number; total: number }): string {
  if (l.state === 'recording') return 'Recording';
  if (p?.phase === 'generating') return p.total > 1 ? `Making cards ${p.done}/${p.total}` : 'Making cards';
  if (l.state === 'generating') return 'Making cards';
  return p?.total ? `Transcribing ${p.done}/${p.total}` : 'Transcribing';
}

function clock(ms: number) {
  const s = Math.floor(ms / 1000);
  return `${String(Math.floor(s / 60)).padStart(2, '0')}:${String(s % 60).padStart(2, '0')}`;
}

/** Drop cue numbers and timestamps from .srt/.vtt files. */
export function stripSubtitles(text: string): string {
  if (!/-->/.test(text)) return text;
  return text
    .split(/\r?\n/)
    .filter((line) => line.trim() && !/-->/.test(line) && !/^\d+$/.test(line.trim()) && !/^WEBVTT/.test(line))
    .join(' ');
}

function safeGet(k: string) {
  try {
    return localStorage.getItem(k);
  } catch {
    return null;
  }
}
function safeSet(k: string, v: string) {
  try {
    localStorage.setItem(k, v);
  } catch {
    /* ignore */
  }
}
