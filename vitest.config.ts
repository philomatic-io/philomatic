import { defineConfig } from 'vitest/config';

// Include/exclude stay on the CLI (see package.json's test scripts); this only wires the
// global setup that gives hosted-mode tests a KEK, since hosted libraries encrypt at rest.
export default defineConfig({
  test: {
    setupFiles: ['test/setup.ts'],
  },
});
