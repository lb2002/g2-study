import './ui/styles.css';
import { StudyApp } from './core';
import { GlassesController } from './glasses/controller';
import type { GlassesHost } from './glasses/host';
import { EvenHost, hasEvenHost } from './glasses/host-even';
import { PreviewHost } from './glasses/host-preview';
import { SettingsStore } from './settings';
import { Store } from './storage/db';
import { PhoneUI } from './ui/app';

/**
 * Demo helpers for the dev server only (`npm run dev`, which is what the
 * simulator loads). Packaged builds ignore URL parameters, so a crafted link
 * cannot change where audio is sent.
 *   ?profile=name  separate deck, e.g. a fresh one per demo take
 *   ?seed=sample   fill an empty deck with cards from the bundled sample lecture
 *   ?timescale=30  run commute rounds on a 30x clock
 *   ?whisper=URL   Whisper-compatible server without auth, for this session only
 */
const devParams = import.meta.env.DEV ? new URLSearchParams(location.search) : new URLSearchParams();

async function boot() {
  const root = document.getElementById('app')!;
  const profile = devParams.get('profile')?.replace(/[^\w-]/g, '');
  const store = await Store.open(profile ? `g2-study-${profile}` : undefined);
  const settings = new SettingsStore();

  let host: GlassesHost;
  let preview: PreviewHost | undefined;
  if (hasEvenHost()) {
    host = await EvenHost.connect();
  } else {
    preview = new PreviewHost(document.getElementById('glasses-canvas') as HTMLCanvasElement);
    host = preview;
  }

  const app = new StudyApp(store, settings, host);
  const glasses = new GlassesController(app, host);
  // The glasses page must exist before the mic can be opened (createStartUpPageContainer first).
  await glasses.start();
  new PhoneUI(root, app, glasses, preview).mount();

  // Lectures interrupted by a reload (e.g. the webview was killed) resume their pipeline.
  for (const l of await store.listLectures()) {
    if (l.state === 'recording') await store.updateLecture(l.id, { state: 'transcribing' });
    if (l.state === 'recording' || l.state === 'transcribing' || l.state === 'generating') void app.retry(l.id);
  }

  if (import.meta.env.DEV) await applyDemoParams(app, settings, store);
}

async function applyDemoParams(app: StudyApp, settings: SettingsStore, store: Store) {
  const scale = Number(devParams.get('timescale'));
  if (scale >= 1) settings.update((d) => (d.demo.timeScale = scale));
  const whisper = devParams.get('whisper');
  if (whisper && /^https?:\/\//.test(whisper)) settings.overrideForSession((d) => Object.assign(d.transcribe, { provider: 'whisper-http', baseUrl: whisper, apiKey: '' }));
  if (devParams.get('seed') === 'sample' && (await store.listCards()).length === 0) {
    const { default: text } = await import('../samples/public-key-crypto.txt?raw');
    await app.importText('Sample: Public-key cryptography', text, { wait: true });
    await app.acceptCards((await app.drafts()).map((c) => c.id));
  }
  (window as unknown as { g2study: unknown }).g2study = { app };
}

boot().catch((err) => {
  console.error(err);
  document.getElementById('app')!.textContent = `G2 Study failed to start: ${(err as Error).message}`;
});
