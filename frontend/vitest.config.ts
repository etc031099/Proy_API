import { fileURLToPath } from 'node:url';
import { defineConfig } from 'vitest/config';

export default defineConfig({
  esbuild: { jsx: 'automatic' },
  resolve: {
    alias: { '@': fileURLToPath(new URL('./src', import.meta.url)) },
  },
  test: {
    include: [
      'test/mlForecast.api.test.ts',
      'test/mlForecast.component.test.tsx',
      'test/systemPagination.component.test.tsx',
      'test/assistant.api.test.ts',
      'test/assistant.component.test.tsx',
      'test/assistant.history.test.tsx',
    ],
    environment: 'jsdom',
    setupFiles: ['./test/setup.ts'],
    clearMocks: true,
    restoreMocks: true,
  },
});
