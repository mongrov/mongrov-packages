import { defineConfig } from 'vitest/config'

export default defineConfig({
  test: {
    // Per-test env: node by default; React/component tests opt in via
    //   // @vitest-environment jsdom
    // at the top of the file.
    environment: 'node',
    include: ['src/**/__tests__/**/*.test.{ts,tsx}'],
    coverage: {
      provider: 'v8',
      reporter: ['text', 'lcov'],
      include: ['src/**/*.{ts,tsx}'],
      exclude: ['src/**/__tests__/**', 'src/**/index.ts'],
      thresholds: {
        lines: 70,
        branches: 70,
        functions: 70,
        statements: 70,
      },
    },
  },
})
