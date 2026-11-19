import './ui/styles.css';
import { StudyApp } from './core';
import { GlassesController } from './glasses/controller';
import type { GlassesHost } from './glasses/host';
import { EvenHost, hasEvenHost } from './glasses/host-even';
import { PreviewHost } from './glasses/host-preview';
import { SettingsStore } from './settings';
import { Store } from './storage/db';
import { PhoneUI } from './ui/app';

async function boot() {
  const root = document.getElementById('app')!;
  const params = new URLSearchParams(location.search);
  // ?profile=name keeps a separate deck (e.g. a fresh one for each demo take).
  const profile = params.get('profile')?.replace(/[^\w-]/g, '');
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

  // Demo helpers (the simulator's webview has its own storage, so these save clicks when recording a demo):
  //   ?seed=sample   fill an empty deck with cards from the bundled sample lecture
  //   ?timescale=30  run commute rounds on a 30x clock
  //   ?whisper=URL   use a Whisper-compatible server without auth (e.g. your home server)
  const scale = Number(params.get('timescale'));
  if (scale >= 1) settings.update((d) => (d.demo.timeScale = scale));
  const whisper = params.get('whisper');
  if (whisper && /^https?:\/\//.test(whisper)) settings.update((d) => Object.assign(d.transcribe, { provider: 'whisper-http', baseUrl: whisper, apiKey: '' }));
  if (params.get('seed') === 'sample' && (await store.listCards()).length === 0) {
    const { default: text } = await import('../samples/public-key-crypto.txt?raw');
    await app.importText('Sample: Public-key cryptography', text, { wait: true });
    await app.acceptCards((await app.drafts()).map((c) => c.id));
  }

  (window as unknown as { g2study: unknown }).g2study = { app, glasses };
}

boot().catch((err) => {
  console.error(err);
  document.getElementById('app')!.textContent = `G2 Study failed to start: ${(err as Error).message}`;
});
