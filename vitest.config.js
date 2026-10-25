import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    include: ['test/**/*.test.js'],
    // Tests create real git repositories, run generated bash scripts and a stand-in gh (a Node
    // process per call); a whole --execute --pr run takes a few seconds on a busy CI runner.
    testTimeout: 60_000,
    hookTimeout: 60_000,
  },
});
