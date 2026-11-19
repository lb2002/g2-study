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
  const store = await Store.open();
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

  (window as unknown as { g2study: unknown }).g2study = { app, glasses };
}

boot().catch((err) => {
  console.error(err);
  document.getElementById('app')!.textContent = `G2 Study failed to start: ${(err as Error).message}`;
});
