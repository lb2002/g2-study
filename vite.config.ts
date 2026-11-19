import { loadEnv } from 'vite';
import { defineConfig } from 'vitest/config';

// API keys are entered in the phone UI (Settings) and stored on the device.
// For local development you may put defaults in .env.local, but Vite inlines
// every VITE_* variable into the bundle, so a production build that would ship
// a key is refused here.
export default defineConfig(({ mode }) => {
  const env = loadEnv(mode, process.cwd(), 'VITE_');
  if (mode === 'production') {
    const leaking = Object.keys(env).filter((k) => /KEY|TOKEN|SECRET/i.test(k) && env[k]);
    if (leaking.length) {
      throw new Error(
        `Refusing to build: ${leaking.join(', ')} would be baked into the plugin bundle. ` +
          'Remove them from your .env files and enter keys in the app Settings instead.',
      );
    }
  }
  return {
    base: './',
    server: { host: true, port: 5173, strictPort: true },
    build: { target: 'es2022', outDir: 'dist', emptyOutDir: true },
    test: { environment: 'node', include: ['tests/**/*.test.ts'] },
  };
});
