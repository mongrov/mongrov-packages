/*
 * Every bounded macro's parameters resolve to TIMESTAMP at bind time
 * (zivaone_app#191).
 *
 * DuckDB binds a macro body at CREATE MACRO time with its parameters untyped.
 * Where it cannot infer a type — `lo - INTERVAL 15 MINUTE`, arithmetic on a
 * bare parameter — it raises ParameterNotResolvedException internally. The
 * desktop builds swallow that and create the macro anyway, which is why every
 * test here passed. The react-native-duckdb build on device lets it escape:
 * the CREATE fails, and with it the whole attach.
 *
 * So passing on desktop proves nothing about the device. This asserts the
 * property the device actually needs, which the desktop build CAN report: bind
 * each macro body as a prepared statement with `$lo` / `$hi` in place of the
 * parameters, and require both to come back typed. Before the fix every `_q`
 * and `_clean` macro reported type 0 (unresolved) here, while
 * `v_motion_between` — which only compares `ts >= lo`, and did create on the
 * device — reported TIMESTAMP. That split is exactly what the device showed.
 */
import { DuckDBInstance, DuckDBTypeId } from '@duckdb/node-api'
import { describe, expect, it } from 'vitest'
import { qualityMacroDdls, qualityViewDdls } from '../../core/reading-quality'
import { generateViewDdl, LOCAL_SCHEMAS, TABLE_NAMES, VIEWED_TABLES } from '../../core/schemas'

const MACRO_HEAD = /^CREATE OR REPLACE MACRO \S+\(lo, hi\) AS TABLE\s*/

describe('bounded macro parameters', () => {
  it('are never used bare — every occurrence of lo and hi is CAST to TIMESTAMP', () => {
    // Per OCCURRENCE, not per parameter. The type check below cannot see a
    // single bare use: DuckDB unifies a parameter's type across the statement,
    // so one CAST elsewhere types it everywhere — and a mutation leaving one
    // bare `lo - INTERVAL ...` passed that check. On device the bare use is
    // bound on its own and can still fail, so none may remain.
    const bare: string[] = []
    for (const macro of qualityMacroDdls()) {
      const body = macro.sql.replace(MACRO_HEAD, '')
        .replace(/CAST\(lo AS TIMESTAMP\)/g, '')
        .replace(/CAST\(hi AS TIMESTAMP\)/g, '')
      for (const m of body.matchAll(/\b(lo|hi)\b/g))
        bare.push(`${macro.name}: ${body.slice(Math.max(0, m.index! - 30), m.index! + 30).replace(/\s+/g, ' ')}`)
    }
    expect(bare).toEqual([])
  })

  it('resolve to TIMESTAMP when the body is bound — no parameter left for DuckDB to infer', async () => {
    const instance = await DuckDBInstance.create(':memory:')
    const conn = await instance.connect()
    await conn.run('INSTALL icu; LOAD icu;')
    for (const t of TABLE_NAMES) await conn.run(LOCAL_SCHEMAS[t])
    for (const t of VIEWED_TABLES)
      await conn.run(generateViewDdl(t, { brand: 'ziva', familyId: 'f', localCatalog: 'memory' }))
    for (const v of qualityViewDdls()) await conn.run(v.sql)

    const resolved: Record<string, string> = {}
    for (const macro of qualityMacroDdls()) {
      expect(macro.sql).toMatch(MACRO_HEAD)
      const body = macro.sql.replace(MACRO_HEAD, '').replace(/;\s*$/, '').replace(/\blo\b/g, '$lo').replace(/\bhi\b/g, '$hi')
      const prepared = await conn.prepare(body)
      const types: string[] = []
      for (let i = 1; i <= prepared.parameterCount; i += 1)
        types.push(`${prepared.parameterName(i)}=${DuckDBTypeId[prepared.parameterTypeId(i)]}`)
      resolved[macro.name] = types.sort().join(' ')
      // Later clean macros call the _q macros, so create each as we go.
      await conn.run(macro.sql)
    }

    // Not vacuous: every macro was bound, and each has exactly lo and hi.
    expect(Object.keys(resolved)).toHaveLength(qualityMacroDdls().length)
    for (const [name, types] of Object.entries(resolved))
      expect({ name, types }).toEqual({ name, types: 'hi=TIMESTAMP lo=TIMESTAMP' })

    conn.closeSync()
    instance.closeSync()
  }, 120_000)
})
