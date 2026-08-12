/**
 * Every SQL builder must survive a catalog name that is not a bare identifier.
 *
 * The catalog comes from the database filename, so a real install yields
 * `zivaone-analytics`. That broke, one reload at a time:
 *   0.8.4 — ensureSchemas / qualifyDdl
 *   0.8.5 — all 15 interpolations in migrations.ts
 *   0.8.6 — generateViewDdl
 *
 * Three rounds of the same defect is a sign the per-site grep was the wrong
 * tool. This drives EVERY exported SQL builder with a hostile catalog and
 * asserts none emits it bare, so a new builder that forgets to quote fails
 * here rather than on a device.
 */
import { describe, expect, it } from 'vitest'

import { buildDeleteSql } from '../retention'
import {
  generateViewDdl,
  insightIndexDdl,
  LOCAL_SCHEMAS,
  qualifyDdl,
  TABLE_NAMES,
  VIEWED_TABLES,
} from '../schemas'

const HOSTILE = 'zivaone-analytics'

/** Any occurrence of the catalog NOT wrapped in double quotes. */
function hasUnquoted(sql: string): boolean {
  return new RegExp(`(^|[^"])${HOSTILE}([^"]|$)`).test(sql)
}

describe('catalog quoting across every SQL builder', () => {
  it('qualifyDdl — all tables', () => {
    for (const table of TABLE_NAMES) {
      const sql = qualifyDdl(LOCAL_SCHEMAS[table], table, HOSTILE)
      expect(hasUnquoted(sql), `qualifyDdl(${table})`).toBe(false)
    }
  })

  it('generateViewDdl — local mode, all viewed tables', () => {
    for (const table of VIEWED_TABLES) {
      const sql = generateViewDdl(table, {
        brand: 'ziva',
        familyId: 'fam_1',
        localCatalog: HOSTILE,
      })
      expect(hasUnquoted(sql), `generateViewDdl(${table}) local`).toBe(false)
    }
  })

  it('generateViewDdl — union mode quotes both catalogs', () => {
    for (const table of VIEWED_TABLES) {
      const sql = generateViewDdl(table, {
        brand: 'ziva',
        familyId: 'fam_1',
        localCatalog: HOSTILE,
        remoteCatalog: 'remote-warehouse',
      })
      expect(hasUnquoted(sql), `generateViewDdl(${table}) union`).toBe(false)
      expect(/(^|[^"])remote-warehouse([^"]|$)/.test(sql)).toBe(false)
    }
  })

  it('insightIndexDdl', () => {
    expect(hasUnquoted(insightIndexDdl(HOSTILE))).toBe(false)
  })

  it('buildDeleteSql', () => {
    const sql = buildDeleteSql({
      catalog: HOSTILE,
      table: 'hrv',
      cutoffDays: 30,
    } as never)
    expect(hasUnquoted(sql)).toBe(false)
  })
})
