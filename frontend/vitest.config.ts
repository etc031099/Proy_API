import { fileURLToPath } from 'node:url';
import { defineConfig } from 'vitest/config';

export default defineConfig({
  esbuild: { jsx: 'automatic' },
  resolve: {
    alias: { '@': fileURLToPath(new URL('./src', import.meta.url)) },
  },
  test: {
    include: [
      'test/remoteEntitySelect.test.tsx',
      'test/contactsPagination.test.tsx',
      'test/textEncoding.test.ts',
      'test/telegramRecovery.test.tsx',
      'test/telegramPreferences.test.tsx',
      'test/mlForecast.api.test.ts',
      'test/mlForecast.component.test.tsx',
      'test/systemPagination.component.test.tsx',
      'test/assistant.api.test.ts',
      'test/assistant.component.test.tsx',
      'test/assistant.history.test.tsx',
      'test/assistant.actions.test.tsx',
      'test/demoV2Registration.test.tsx',
      'test/demoV3Registration.test.tsx',
      'test/businessIntelligenceDashboard.test.tsx',
      'test/forecastEvaluation.test.tsx',
      'test/customerClustering.test.tsx',
      'test/salesAnomalies.test.tsx',
      'test/businessIntelligenceExtended.api.test.ts',
      'test/intelligenceReadCache.test.ts',
      'test/businessIntelligenceExtended.component.test.tsx',
    ],
    environment: 'jsdom',
    setupFiles: ['./test/setup.ts'],
    clearMocks: true,
    restoreMocks: true,
  },
});
