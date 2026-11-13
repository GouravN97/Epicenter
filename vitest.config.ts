import { defineConfig } from 'vitest/config';

// Pure-logic tests only (plan §2): dedup, aggregator, detector, correlator, series buffer, shared contract.
export default defineConfig({
  test: {
    include: ['{shared,server,simulator,client,tools}/**/src/**/*.test.ts'],
    exclude: ['**/node_modules/**', '**/dist/**'],
    environment: 'node',
  },
});
