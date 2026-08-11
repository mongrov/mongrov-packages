/**
 * Catalog identifier quoting.
 *
 * The catalog name comes from the database filename, so
 * `zivaone-analytics.duckdb` yields the catalog `zivaone-analytics`. A bare
 * hyphen is a syntax error in an identifier position, which failed every
 * migration on device:
 *
 *   CREATE TABLE IF NOT EXISTS zivaone-analytics.hrv (...)
 *                                      ^ syntax error at or near "-"
 */
import { describe, expect, it } from 'vitest'

import { LOCAL_SCHEMAS, qualifyDdl, quoteQualifier } from '../schemas'

describe('quoteQualifier', () => {
  it('leaves plain identifiers bare', () => {
    expect(quoteQualifier('memory')).toBe('memory')
    expect(quoteQualifier('main_db')).toBe('main_db')
    expect(quoteQualifier('remote.analytics')).toBe('remote.analytics')
  })

  it('quotes names a bare identifier cannot express', () => {
    expect(quoteQualifier('zivaone-analytics')).toBe('"zivaone-analytics"')
    expect(quoteQualifier('has space')).toBe('"has space"')
    expect(quoteQualifier('9starts-with-digit')).toBe('"9starts-with-digit"')
  })

  it('quotes each dotted part independently', () => {
    expect(quoteQualifier('zivaone-analytics.main')).toBe('"zivaone-analytics".main')
  })

  it('leaves already-quoted parts alone', () => {
    expect(quoteQualifier('"pre-quoted"')).toBe('"pre-quoted"')
  })

  it('doubles embedded quotes', () => {
    expect(quoteQualifier('we"ird')).toBe('"we""ird"')
  })
})

describe('qualifyDdl with a hyphenated catalog', () => {
  it('emits parseable DDL — the on-device failure', () => {
    const ddl = qualifyDdl(LOCAL_SCHEMAS.hrv, 'hrv', 'zivaone-analytics')
    expect(ddl).toContain('CREATE TABLE IF NOT EXISTS "zivaone-analytics".hrv')
    expect(ddl).not.toContain('NOT EXISTS zivaone-analytics.hrv')
  })
})
