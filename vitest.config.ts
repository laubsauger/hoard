import { defineConfig } from 'vitest/config';
import { fileURLToPath, URL } from 'node:url';

export default defineConfig({
  resolve: {
    alias: {
      '@': fileURLToPath(new URL('./src', import.meta.url)),
    },
  },
  test: {
    // Core/sim/config logic is environment-free. UI/render lanes add their own jsdom configs later.
    environment: 'node',
    include: ['src/**/*.test.ts'],
    globals: false,
  },
});
