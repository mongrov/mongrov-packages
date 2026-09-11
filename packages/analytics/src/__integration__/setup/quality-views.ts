/**
 * Build the T-25 signal-quality views in a test warehouse.
 *
 * Rules, baselines and tools read `v_{vital}_clean`, which in production
 * `createViews` builds on attach. Suites that hand-build only the tables they
 * seed call this after their own setup: it adds whatever else the quality
 * views read (the other vitals, `activity` for `still`, `temperature` for
 * `worn`) as empty local tables with local-mode union views, then the quality
 * views on top. Idempotent — existing tables are kept, views are replaced.
 */
import { qualityViewDdls } from '../../core/reading-quality'
import { generateViewDdl, LOCAL_SCHEMAS } from '../../core/schemas'

const QUALITY_INPUTS = ['heart_rate', 'hrv', 'spo2', 'temperature', 'activity'] as const

export async function createQualityViews(
  db: { execute: (sql: string) => Promise<unknown> },
  ctx: { brand: string, familyId: string, localCatalog?: string },
): Promise<void> {
  const localCatalog = ctx.localCatalog ?? 'memory'
  for (const t of QUALITY_INPUTS) {
    await db.execute(
      LOCAL_SCHEMAS[t].replace(`CREATE TABLE ${t}`, `CREATE TABLE IF NOT EXISTS ${localCatalog}.${t}`),
    )
    await db.execute(generateViewDdl(t, { brand: ctx.brand, familyId: ctx.familyId, localCatalog }))
  }
  for (const view of qualityViewDdls()) await db.execute(view.sql)
}
