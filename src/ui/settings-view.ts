import { encodeWav } from '../audio/pcm';
import type { StudyApp } from '../core';
import type { Settings } from '../settings';
import { h, icon, toast } from './dom';

type Path = [keyof Settings, string];

/** Settings tab. Every field saves on change; keys live only in this device's storage. */
export function renderSettings(app: StudyApp): HTMLElement {
  const s = app.settings.get();

  const field = (label: string, path: Path, opts: { type?: string; placeholder?: string; hint?: string; min?: number; max?: number; step?: number } = {}) => {
    const [group, key] = path;
    const cur = (s[group] as Record<string, unknown>)[key];
    const input = h('input', {
      type: opts.type ?? (typeof cur === 'number' ? 'number' : 'text'),
      value: String(cur ?? ''),
      placeholder: opts.placeholder,
      min: opts.min,
      max: opts.max,
      step: opts.step,
      autocomplete: 'off',
      spellcheck: 'false',
    });
    input.addEventListener('change', () => {
      app.settings.update((d) => {
        const g = d[group] as Record<string, unknown>;
        g[key] = typeof cur === 'number' ? Number(input.value) || 0 : input.value.trim();
      });
      toast('Saved');
    });
    return h('label', { class: 'field' }, h('span', null, label), input, opts.hint ? h('small', null, opts.hint) : null);
  };

  const choice = <T extends string>(label: string, path: Path, options: [T, string][], onChange?: () => void) => {
    const [group, key] = path;
    const cur = (s[group] as Record<string, unknown>)[key];
    const sel = h('select', null, options.map(([v, l]) => h('option', { value: v, selected: v === String(cur) ? true : null }, l)));
    sel.addEventListener('change', () => {
      app.settings.update((d) => ((d[group] as Record<string, unknown>)[key] = typeof cur === 'number' ? Number(sel.value) : sel.value));
      onChange?.();
      toast('Saved');
    });
    return h('label', { class: 'field' }, h('span', null, label), sel);
  };

  const preset = (label: string, apply: (d: Settings) => void) =>
    h(
      'button',
      {
        class: 'chip',
        onclick: () => {
          app.settings.update(apply);
          rerender();
          toast(`${label} preset applied`);
        },
      },
      label,
    );

  const root = h('div', { class: 'stack' });
  const rerender = () => root.replaceWith(renderSettings(app));

  const testTranscription = async (btn: HTMLButtonElement) => {
    const t = app.transcriber();
    if (!t) return toast('Transcription is off or missing an API key', 'error');
    btn.disabled = true;
    try {
      const silence = new Blob([encodeWav(new Uint8Array(32000)) as BlobPart], { type: 'audio/wav' });
      await t.transcribe(silence, {});
      toast(`Transcription OK (${t.name})`);
    } catch (err) {
      toast((err as Error).message, 'error');
    } finally {
      btn.disabled = false;
    }
  };

  const testCards = async (btn: HTMLButtonElement) => {
    btn.disabled = true;
    try {
      const backend = app.cardBackend();
      const cards = await backend.generate(
        'A hash function maps input of any length to a fixed-length digest. Collision resistance means it is hard to find two inputs with the same digest.',
        { chunkIndex: 0, chunkCount: 1, targetCards: 2 },
      );
      toast(cards.length ? `OK: "${cards[0].front}"` : 'Backend answered but made no cards', cards.length ? 'info' : 'error');
    } catch (err) {
      toast((err as Error).message, 'error');
    } finally {
      btn.disabled = false;
    }
  };

  const tBtn = h('button', { class: 'secondary small' }, 'Test');
  tBtn.addEventListener('click', () => void testTranscription(tBtn));
  const cBtn = h('button', { class: 'secondary small' }, 'Test');
  cBtn.addEventListener('click', () => void testCards(cBtn));

  const cardsRemote = s.cards.provider === 'openai-compatible';

  root.append(
    h(
      'section',
      { class: 'card' },
      h('div', { class: 'card-head' }, h('h2', null, 'Transcription'), tBtn),
      h('p', { class: 'muted small' }, 'Any Whisper-compatible endpoint: OpenAI, or a server on your own machine (speaches / faster-whisper-server, whisper.cpp, LocalAI).'),
      h(
        'div',
        { class: 'chips' },
        preset('OpenAI', (d) => Object.assign(d.transcribe, { provider: 'whisper-http', baseUrl: 'https://api.openai.com/v1', model: 'whisper-1' })),
        preset('Self-hosted', (d) => Object.assign(d.transcribe, { provider: 'whisper-http', baseUrl: 'http://192.168.1.10:8000/v1', model: 'Systran/faster-whisper-small', apiKey: '' })),
      ),
      choice('Provider', ['transcribe', 'provider'], [
        ['whisper-http', 'Whisper-compatible HTTP'],
        ['none', 'Off (keep audio only)'],
      ]),
      field('Base URL', ['transcribe', 'baseUrl'], { placeholder: 'https://api.openai.com/v1' }),
      field('Model', ['transcribe', 'model'], { placeholder: 'whisper-1' }),
      field('API key', ['transcribe', 'apiKey'], { type: 'password', hint: 'Stored on this device only. Leave empty for servers without auth.' }),
      field('Language', ['transcribe', 'language'], { placeholder: 'auto', hint: 'Optional ISO code like en or de. Helps with technical terms.' }),
    ),
    h(
      'section',
      { class: 'card' },
      h('div', { class: 'card-head' }, h('h2', null, 'Card generation'), cBtn),
      h('p', { class: 'muted small' }, 'Any OpenAI-compatible chat API, so a local model works too. "Offline" uses simple rules and needs no setup (good for trying the app, much weaker than a model).'),
      h(
        'div',
        { class: 'chips' },
        preset('Offline', (d) => (d.cards.provider = 'offline')),
        preset('OpenAI', (d) => Object.assign(d.cards, { provider: 'openai-compatible', baseUrl: 'https://api.openai.com/v1', model: 'gpt-4o-mini' })),
        preset('Ollama', (d) => Object.assign(d.cards, { provider: 'openai-compatible', baseUrl: 'http://localhost:11434/v1', model: 'llama3.1:8b', apiKey: '' })),
      ),
      choice('Provider', ['cards', 'provider'], [
        ['offline', 'Offline (rule-based)'],
        ['openai-compatible', 'OpenAI-compatible API'],
      ], rerender),
      cardsRemote ? field('Base URL', ['cards', 'baseUrl'], { placeholder: 'https://api.openai.com/v1' }) : null,
      cardsRemote ? field('Model', ['cards', 'model'], { placeholder: 'gpt-4o-mini' }) : null,
      cardsRemote ? field('API key', ['cards', 'apiKey'], { type: 'password', hint: 'Stored on this device only.' }) : null,
      field('Card language', ['cards', 'language'], { placeholder: 'same as lecture', hint: 'e.g. English, even for a German lecture.' }),
    ),
    h(
      'section',
      { class: 'card' },
      h('h2', null, icon('train'), 'Commute'),
      h('div', { class: 'grid2' }, field('From', ['commute', 'from']), field('To', ['commute', 'to'])),
      h('div', { class: 'grid2' }, field('Stop before arrival (min)', ['commute', 'bufferMin'], { min: 0, max: 15 }), field('Seconds per card (start value)', ['commute', 'defaultSecondsPerCard'], { min: 2, max: 120, hint: 'Replaced by your measured median after a few reviews.' })),
    ),
    h(
      'section',
      { class: 'card' },
      h('h2', null, 'Review and recording'),
      h('div', { class: 'grid2' }, field('New cards per day', ['review', 'newCardsPerDay'], { min: 0, max: 500 }), field('Audio chunk (seconds)', ['recording', 'chunkSeconds'], { min: 15, max: 300 })),
      choice('Demo clock for commute rounds', ['demo', 'timeScale'] as Path, [
        ['1', 'Real time'],
        ['10', '10x faster (demo)'],
        ['30', '30x faster (demo)'],
      ]),
      h('small', { class: 'muted' }, 'The demo clock lets a 20 min ride end in about a minute, so the auto-stop can be shown on video.'),
    ),
    dataSection(app),
    h('p', { class: 'muted small center' }, 'G2 Study 0.1 · tested in the Even Hub simulator only'),
  );
  return root;
}

function dataSection(app: StudyApp) {
  const exportBtn = h('button', { class: 'secondary' }, icon('upload', 16), 'Export deck (JSON)');
  exportBtn.addEventListener('click', async () => {
    const data = { version: 1, exportedAt: new Date().toISOString(), lectures: await app.store.listLectures(), cards: await app.store.listCards(), reviews: await app.store.recentReviews(100000) };
    const blob = new Blob([JSON.stringify(data, null, 1)], { type: 'application/json' });
    const a = h('a', { href: URL.createObjectURL(blob), download: `g2-study-${new Date().toISOString().slice(0, 10)}.json` });
    a.click();
    setTimeout(() => URL.revokeObjectURL(a.href), 1000);
  });
  const importInput = h('input', { type: 'file', accept: 'application/json,.json', class: 'file' });
  importInput.addEventListener('change', async () => {
    const f = importInput.files?.[0];
    if (!f) return;
    try {
      const data = JSON.parse(await f.text());
      for (const l of data.lectures ?? []) await app.store.putLecture(l);
      await app.store.putCards(data.cards ?? []);
      for (const r of data.reviews ?? []) await app.store.putReview(r);
      app.changed.emit();
      toast(`Imported ${(data.cards ?? []).length} cards`);
    } catch (err) {
      toast(`Import failed: ${(err as Error).message}`, 'error');
    }
  });
  const clearBtn = h('button', { class: 'danger' }, icon('trash', 16), 'Delete all data');
  clearBtn.addEventListener('click', async () => {
    if (!confirm('Delete all lectures, cards and review history on this device?')) return;
    await app.store.clearAll();
    app.changed.emit();
    toast('All data deleted');
  });
  return h('section', { class: 'card' }, h('h2', null, 'Data'), h('p', { class: 'muted small' }, 'Everything is stored on this phone, inside the plugin.'), h('div', { class: 'row gap wrap' }, exportBtn, h('label', { class: 'secondary file-label' }, 'Import JSON', importInput)), clearBtn);
}
