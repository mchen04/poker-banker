import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: { reporters: ['default', 'json'], outputFile: { json: 'test-results/vitest.json' }, fileParallelism: false, testTimeout: 30000, hookTimeout: 120000 },
});
