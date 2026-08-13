/**
 * T-19 + T-20 + T-21 — R2 fetcher.
 *
 * Coverage:
 *   1. Prefetch dispatch: `all-family-on-attach` issues one INSERT per table.
 *   2. Prefetch dispatch: `recent-active-only` includes an `active` CTE.
 *   3. Prefetch dispatch: `lazy` is a no-op.
 *   4. `fetchIncremental` advances the fetch watermark to the MAX(ts).
 *   5. Two consecutive incremental fetches only pull new rows on the second
 *      (watermark moved forward).
 *   6. `fetchOnDemand` respects params + limit + bypasses watermark.
 */

import type { AttachContext } from '../../core/types'

import { describe, expect, it } from 'vitest'
import { createFakeKV } from '../../core/__tests__/__fakes__/fake-kv'
import { R2Fetcher } from '../fetcher'
import { WatermarkStore } from '../watermark'
import { createFakeSqlEngine } from './__fakes__/fake-sql-engine'

const ctx: AttachContext = {
  brand: 'ziva',
  tenantScope: 'family',
  tenantId: 'fam_A',
  userId: 'u1',
}

const now = () => new Date('2026-06-01T00:00:00Z')

function newFetcher(tables: string[] = ['hrv']) {
  const { kv, store } = createFakeKV()
  const watermark = new WatermarkStore({ kv, now, defaultRetentionMs: 86_400_000 })
  const fake = createFakeSqlEngine()
  const fetcher = new R2Fetcher({
    engine: fake.engine,
    watermark,
    tables,
    now,
  })
  return { fetcher, fake, watermark, kvStore: store }
}

describe('R2Fetcher.prefetchOnAttach', () => {
  it('all-family-on-attach issues one INSERT per table', async () => {
    const { fetcher, fake } = newFetcher(['hrv', 'hr'])
    // For each table: INSERT + COUNT.
    fake.mockNext([]) // hrv INSERT
    fake.mockNext([{ c: 5 }]) // hrv COUNT
    fake.mockNext([]) // hr INSERT
    fake.mockNext([{ c: 3 }]) // hr COUNT

    const results = await fetcher.prefetchOnAttach(ctx, {
      kind: 'all-family-on-attach',
      windowDays: 7,
    })
    expect(results.every(r => r.ok)).toBe(true)
    const insertCalls = fake.calls.filter(c => c.sql.startsWith('INSERT INTO'))
    expect(insertCalls).toHaveLength(2)
    expect(insertCalls[0]!.sql).toContain('main.hrv')
    expect(insertCalls[0]!.sql).toContain('zone_fam_A.default.hrv')
    // hrv declares no PRIMARY KEY → no ON CONFLICT clause (DuckDB ≥1.5
    // rejects it on key-less tables); watermark advancement is the guard.
    expect(insertCalls[0]!.sql).not.toContain('ON CONFLICT')
    expect(insertCalls[1]!.sql).toContain('main.hr')
  })

  it('recent-active-only wraps the INSERT in an active-user CTE', async () => {
    const { fetcher, fake } = newFetcher(['hrv'])
    fake.mockNext([]) // INSERT
    fake.mockNext([{ c: 0 }]) // COUNT

    await fetcher.prefetchOnAttach(ctx, {
      kind: 'recent-active-only',
      activeDays: 3,
      windowDays: 30,
    })
    const insertCall = fake.calls.find(c => c.sql.startsWith('WITH active AS'))
    expect(insertCall).toBeDefined()
    expect(insertCall!.sql).toContain('JOIN active a ON r.user_id = a.user_id')
    expect(insertCall!.params).toMatchObject({ familyId: 'fam_A' })
  })

  it('lazy is a no-op', async () => {
    const { fetcher, fake } = newFetcher(['hrv', 'hr'])
    const results = await fetcher.prefetchOnAttach(ctx, { kind: 'lazy' })
    expect(results.every(r => r.ok && r.rowsFetched === 0)).toBe(true)
    expect(fake.calls).toHaveLength(0)
  })
})

describe('R2Fetcher.fetchIncremental', () => {
  it('pulls new rows and advances the fetch watermark to MAX(ts)', async () => {
    const { fetcher, fake, kvStore } = newFetcher(['hrv'])
    fake.mockNext([]) // INSERT
    fake.mockNext([{ max_ts: '2026-06-01T00:00:00.000Z', row_count: 4 }])

    const results = await fetcher.fetchIncremental(ctx)
    expect(results[0]!).toMatchObject({ table: 'hrv', ok: true, rowsFetched: 4 })
    expect(kvStore.get('analytics:watermark:ziva:fam_A:hrv:fetch'))
      .toBe('2026-06-01T00:00:00.000Z')
  })

  it('subsequent incremental fetch queries with advanced watermark', async () => {
    const { fetcher, fake } = newFetcher(['hrv'])
    // First fetch: pulls up to a specific ts (must be after default watermark
    // of 2026-05-31 so `advance` actually moves it forward).
    fake.mockNext([])
    fake.mockNext([{ max_ts: '2026-06-15T00:00:00.000Z', row_count: 2 }])
    await fetcher.fetchIncremental(ctx)

    // Second fetch: no new rows.
    fake.mockNext([])
    fake.mockNext([{ max_ts: null, row_count: 0 }])
    const second = await fetcher.fetchIncremental(ctx)
    expect(second[0]!.rowsFetched).toBe(0)

    // The second INSERT must use the advanced watermark, not the default.
    const secondInsert = fake.calls.filter(c => c.sql.includes('INSERT INTO main.hrv'))[1]!
    expect(secondInsert.params).toMatchObject({
      watermark: '2026-06-15T00:00:00.000Z',
    })
  })
})

describe('R2Fetcher.fetchOnDemand', () => {
  it('honours since/until/limit and bypasses watermark', async () => {
    const { fetcher, fake, kvStore } = newFetcher(['hrv'])
    fake.mockNext([]) // INSERT
    // Un-truncated: 7 rows < limit 100.
    fake.mockNext([{ max_ts: '2026-06-10T00:00:00.000Z', row_count: 7 }])

    const result = await fetcher.fetchOnDemand(ctx, {
      table: 'hrv',
      since: new Date('2026-05-25T00:00:00Z'),
      until: new Date('2026-06-15T00:00:00Z'),
      limit: 100,
    })
    expect(result).toEqual({ table: 'hrv', rowsFetched: 7, ok: true })
    expect(fake.calls[0]!.sql).toContain('LIMIT 100')
    // LIMIT must be ordered by the time column so a truncated fetch is a
    // contiguous prefix (SY-1).
    expect(fake.calls[0]!.sql).toContain('ORDER BY ts ASC LIMIT 100')
    expect(fake.calls[0]!.sql).toContain('ts <= $until')
    // hrv declares no PRIMARY KEY → no ON CONFLICT clause (DuckDB ≥1.5
    // rejects it on key-less tables).
    expect(fake.calls[0]!.sql).not.toContain('ON CONFLICT')
    // Un-truncated → the full range was covered → watermark = `until`
    // (must be after default watermark to move).
    expect(kvStore.get('analytics:watermark:ziva:fam_A:hrv:fetch'))
      .toBe('2026-06-15T00:00:00.000Z')
  })

  it('truncated fetch advances watermark only to the max fetched ts (SY-1)', async () => {
    const { fetcher, fake, kvStore } = newFetcher(['hrv'])
    fake.mockNext([]) // INSERT
    // Truncated: row_count == limit; max inserted ts well before `until`.
    fake.mockNext([{ max_ts: '2026-06-05T00:00:00.000Z', row_count: 50 }])

    const result = await fetcher.fetchOnDemand(ctx, {
      table: 'hrv',
      since: new Date('2026-05-25T00:00:00Z'),
      until: new Date('2026-06-15T00:00:00Z'),
      limit: 50,
    })
    expect(result).toEqual({ table: 'hrv', rowsFetched: 50, ok: true })
    // NOT `until` — rows in (max_ts, until] were never inserted and must
    // stay visible to fetchIncremental.
    expect(kvStore.get('analytics:watermark:ziva:fam_A:hrv:fetch'))
      .toBe('2026-06-05T00:00:00.000Z')
  })

  it('follow-up incremental after a truncated fetch picks up the remainder', async () => {
    const { fetcher, fake } = newFetcher(['hrv'])
    // Truncated on-demand fetch up to 2026-06-05.
    fake.mockNext([]) // INSERT
    fake.mockNext([{ max_ts: '2026-06-05T00:00:00.000Z', row_count: 50 }])
    await fetcher.fetchOnDemand(ctx, {
      table: 'hrv',
      since: new Date('2026-05-25T00:00:00Z'),
      until: new Date('2026-06-15T00:00:00Z'),
      limit: 50,
    })

    // Incremental must query strictly after the truncated cursor, so the
    // skipped (2026-06-05, 2026-06-15] remainder is still in range.
    fake.mockNext([]) // INSERT
    fake.mockNext([{ max_ts: '2026-06-15T00:00:00.000Z', row_count: 12 }])
    const results = await fetcher.fetchIncremental(ctx)
    expect(results[0]!).toMatchObject({ ok: true, rowsFetched: 12 })
    const incrementalInsert = fake.calls.filter(
      c => c.sql.startsWith('INSERT INTO main.hrv') && c.sql.includes('$watermark'),
    )[0]!
    expect(incrementalInsert.params).toMatchObject({
      watermark: '2026-06-05T00:00:00.000Z',
    })
  })

  it('empty un-truncated fetch advances watermark to until', async () => {
    const { fetcher, fake, kvStore } = newFetcher(['hrv'])
    fake.mockNext([]) // INSERT
    fake.mockNext([{ max_ts: null, row_count: 0 }])

    const result = await fetcher.fetchOnDemand(ctx, {
      table: 'hrv',
      since: new Date('2026-05-25T00:00:00Z'),
      until: new Date('2026-06-15T00:00:00Z'),
      limit: 50,
    })
    expect(result).toEqual({ table: 'hrv', rowsFetched: 0, ok: true })
    // Zero rows below the limit → range fully covered (it's just empty);
    // advancing to `until` prevents refetching the empty range.
    expect(kvStore.get('analytics:watermark:ziva:fam_A:hrv:fetch'))
      .toBe('2026-06-15T00:00:00.000Z')
  })

  it('truncated fetch with no anchor ts does not advance (defensive edge)', async () => {
    const { fetcher, fake, kvStore } = newFetcher(['hrv'])
    fake.mockNext([]) // INSERT
    // Degenerate engine response: claims a full page but no max ts.
    fake.mockNext([{ max_ts: null, row_count: 50 }])

    const result = await fetcher.fetchOnDemand(ctx, {
      table: 'hrv',
      since: new Date('2026-05-25T00:00:00Z'),
      until: new Date('2026-06-15T00:00:00Z'),
      limit: 50,
    })
    expect(result.ok).toBe(true)
    // Nothing to anchor to — watermark untouched.
    expect(kvStore.get('analytics:watermark:ziva:fam_A:hrv:fetch'))
      .toBeUndefined()
  })

  it('un-truncated fetch without until advances to now()', async () => {
    const { fetcher, fake, kvStore } = newFetcher(['hrv'])
    fake.mockNext([]) // INSERT
    fake.mockNext([{ max_ts: '2026-05-30T00:00:00.000Z', row_count: 3 }])

    await fetcher.fetchOnDemand(ctx, {
      table: 'hrv',
      since: new Date('2026-05-25T00:00:00Z'),
    })
    expect(kvStore.get('analytics:watermark:ziva:fam_A:hrv:fetch'))
      .toBe(now().toISOString())
  })
})

describe('R2Fetcher time column resolution', () => {
  it('prefetchOnAttach uses ts_start for sleep_session', async () => {
    const { fetcher, fake } = newFetcher(['sleep_session'])
    fake.mockNext([]) // INSERT
    fake.mockNext([{ c: 2 }]) // COUNT
    await fetcher.prefetchOnAttach(ctx, {
      kind: 'all-family-on-attach',
      windowDays: 7,
    })
    const insert = fake.calls.find(c => c.sql.startsWith('INSERT INTO main.sleep_session'))!
    expect(insert.sql).toContain('ts_start >= $cutoff')
    expect(insert.sql).not.toMatch(/\bts >=/)
    const count = fake.calls.find(c => c.sql.startsWith('SELECT COUNT'))!
    expect(count.sql).toContain('ts_start >= $cutoff')
  })

  it('fetchIncremental uses valid_from for device_config', async () => {
    const { fetcher, fake } = newFetcher(['device_config'])
    fake.mockNext([]) // INSERT
    fake.mockNext([{ max_ts: '2026-06-01T00:00:00.000Z', row_count: 1 }])
    await fetcher.fetchIncremental(ctx)
    const insert = fake.calls.find(c => c.sql.startsWith('INSERT INTO main.device_config'))!
    expect(insert.sql).toContain('valid_from > $watermark')
    const maxCall = fake.calls.find(c => c.sql.startsWith('SELECT MAX'))!
    expect(maxCall.sql).toContain('MAX(valid_from)')
    expect(maxCall.sql).toContain('valid_from > $watermark')
  })

  it('fetchOnDemand uses ts_start for sleep_session', async () => {
    const { fetcher, fake } = newFetcher(['sleep_session'])
    fake.mockNext([]) // INSERT
    fake.mockNext([{ max_ts: '2026-06-10T00:00:00.000Z', row_count: 3 }]) // stats
    await fetcher.fetchOnDemand(ctx, {
      table: 'sleep_session',
      since: new Date('2026-05-25T00:00:00Z'),
      until: new Date('2026-06-15T00:00:00Z'),
    })
    expect(fake.calls[0]!.sql).toContain('ts_start >= $since')
    expect(fake.calls[0]!.sql).toContain('ts_start <= $until')
    expect(fake.calls[0]!.sql).not.toMatch(/\bts >=/)
  })
})
