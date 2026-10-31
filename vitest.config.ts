import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    include: ['test/**/*.test.ts'],
    // Forks, not threads: the config-file test calls process.chdir, which workers cannot.
    pool: 'forks',
    testTimeout: 30_000,
  },
});
