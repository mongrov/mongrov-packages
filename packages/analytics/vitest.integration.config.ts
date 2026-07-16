/**
 * Vitest config for the MinIO + Iceberg REST integration suite.
 *
 * Runs only `*.integration.test.ts` files, boots the docker-compose
 * stack via `src/__integration__/setup/global-setup.ts`, and forces
 * a single fork so DuckDB's native state + docker ports don't
 * contend across parallel workers.
 *
 * Invoked by `pnpm test:integration`; the unit run
 * (`vitest.config.ts`) excludes `*.integration.test.ts` so the two
 * suites don't collide.
 *
 * Standalone (not `mergeConfig(base)`) because Vitest concatenates
 * array fields during merge: the base `exclude` still wins over our
 * `include` if we merge, so the integration files never load.
 */
import { defineConfig } from 'vitest/config'

export default defineConfig({
  test: {
    environment: 'node',
    include: ['src/**/__tests__/**/*.integration.test.{ts,tsx}'],
    globalSetup: ['./src/__integration__/setup/global-setup.ts'],
    // ATTACH + first Iceberg commit are slow on cold extension load.
    testTimeout: 60_000,
    hookTimeout: 60_000,
    // Isolate DuckDB native state per suite; avoid parallel workers
    // racing on the shared MinIO stack.
    pool: 'forks',
    poolOptions: { forks: { singleFork: true } },
    coverage: { enabled: false },
  },
})
