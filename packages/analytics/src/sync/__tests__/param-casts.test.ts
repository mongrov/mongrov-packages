/**
 * Guards the untyped-bound-parameter class (zivaone_app#70, #72) in the
 * platform's own tool impls.
 *
 * react-native-duckdb prepares a statement with NO values and executes with
 * them, so a parameter's type must resolve from SQL context at prepare time.
 * Where there is none it stays UNKNOWN and the bind throws
 * `ParameterNotResolvedException` — which is not in DuckDB's
 * transaction-exempt set, so it also invalidates the shared connection and
 * unrelated queries fail afterwards with `TransactionException`.
 *
 * The reason this is a SHAPE test rather than an execution test is the whole
 * point: node/Python DuckDB hand values to the binder, so the type always
 * resolves and a local harness reports every one of these as passing. Only
 * the device shows the failure, so the only thing worth asserting off-device
 * is the shape of the SQL.
 *
 * The same guard over a domain pack's baseline SQL and tool impls lives with
 * the pack (zivaone_app `@zivaone/health`, `src/__tests__/param-casts.test.ts`).
 */
import { readFileSync } from 'node:fs'
import { join } from 'node:path'

import { describe, expect, it } from 'vitest'

describe('tools/impls bind no untyped interval params', () => {
  const PLATFORM_DIR = join(__dirname, '..', '..', 'tools', 'impls')
  const FILES = ['insights.ts']

  for (const file of FILES) {
    it(`${file} — every INTERVAL parameter is cast`, () => {
      const src = readFileSync(join(PLATFORM_DIR, file), 'utf8')
      // `INTERVAL (${jsExpr})` is interpolation, not binding — no param
      // reaches the driver, so those are fine. Only `$name` matters.
      const bare = Array.from(src.matchAll(/INTERVAL\s*\(\s*\$([a-z_]\w*)\s*\)/gi), m => m[1])
      expect(bare).toEqual([])
    })
  }
})
