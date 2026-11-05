import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    include: ['extension/src/**/*.test.ts'],
    coverage: {
      provider: 'v8',
      include: ['extension/src/**/*.ts'],
      exclude: ['**/*.test.ts', '**/*.generated.ts'],
      reporter: ['text-summary', 'json-summary', 'html'],
      reportsDirectory: 'test-results/coverage',
      // Floors just under the measured coverage, so a drop fails `npm run check` and CI.
      // The safety-critical code (what decides allow or refuse, and the site decoders and judges that feed
      // it) is held near full coverage; browser glue and UI are covered mostly by the e2e suites.
      thresholds: {
        lines: 55, statements: 52, branches: 55, functions: 50,
        'extension/src/background/{decision,fingerprint,recovery,unguarded,interception,rules,uiactions,sites}.ts': {
          lines: 93, statements: 90, branches: 85, functions: 85,
        },
        'extension/src/background/codecs/**': { lines: 95, branches: 75, functions: 90 },
        'extension/src/background/judge/**': { lines: 93, branches: 75, functions: 80 },
      },
    },
  },
});
