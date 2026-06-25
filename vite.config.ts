import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';
import { fileURLToPath, URL } from 'node:url';

// WebGPU + SharedArrayBuffer require cross-origin isolation (V-stack, R13).
const crossOriginIsolation = {
  name: 'cross-origin-isolation',
  configureServer(server: { middlewares: { use: (fn: (req: unknown, res: { setHeader: (k: string, v: string) => void }, next: () => void) => void) => void } }) {
    server.middlewares.use((_req, res, next) => {
      res.setHeader('Cross-Origin-Opener-Policy', 'same-origin');
      res.setHeader('Cross-Origin-Embedder-Policy', 'require-corp');
      next();
    });
  },
};

export default defineConfig({
  // Deployed as a GitHub Pages PROJECT site at https://laubsauger.github.io/hoard/ — assets must resolve under
  // the `/hoard/` sub-path. `BASE_URL` becomes `/hoard/` in the build (`/` in dev), which assetUrl() prefixes
  // onto runtime asset paths. Override at build time with VITE_BASE for a different host (e.g. a custom domain).
  base: process.env.VITE_BASE ?? '/hoard/',
  plugins: [react(), crossOriginIsolation],
  resolve: {
    alias: {
      '@': fileURLToPath(new URL('./src', import.meta.url)),
    },
  },
  build: {
    rollupOptions: {
      // HTML entries: the main game + two isolated WebGPU test harnesses (the single-zombie ragdoll-test and the
      // dense crowd-test, served at /ragdoll-test.html and /crowd-test.html in dev; included in `npm run build`).
      input: {
        main: fileURLToPath(new URL('./index.html', import.meta.url)),
        ragdollTest: fileURLToPath(new URL('./ragdoll-test.html', import.meta.url)),
        crowdTest: fileURLToPath(new URL('./crowd-test.html', import.meta.url)),
      },
    },
  },
});
