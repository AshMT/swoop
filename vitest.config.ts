import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    include: ['tests/**/*.test.ts'],
    environment: 'node',
    // The API tests share one in-memory SQLite database, so they must not run
    // concurrently against it.
    fileParallelism: false,
    coverage: {
      include: ['src/**/*.ts'],
      exclude: ['src/server.ts', 'src/version.ts'],
    },
  },
});
