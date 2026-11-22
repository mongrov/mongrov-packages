/**
 * The pluggable renderer (default `lines`) and the character budget: 1,200
 * chars per result and 3,600 per answer, oldest list items dropped first,
 * then a line cut. `truncated` is the framework's alone.
 */

import type { ToolOutcome } from '../outcome'
import type { RenderContext } from '../render'
import type { SeriesData } from './support/structured'
import { afterEach, describe, expect, it } from 'vitest'
import { resetPacks } from '../../core/packs'
import { fitOutcome, hardCut, MIN_TURN_CHARS } from '../fit'
import { outcome } from '../outcome'
import { describeAge, pickRenderer, renderers } from '../render'
import { call, NOW, okOutcome, seriesData, seriesTool, setup, WINDOW } from './support/structured'

afterEach(() => resetPacks())

const rc: RenderContext = { toolName: 'getSeries', maxChars: 1200, now: NOW }

describe('renderers.lines (the default)', () => {
  it('golden: header, notes before data, scalars, a nested object as pairs, a list as a table', () => {
    const text = renderers.lines(okOutcome(3), rc)
    expect(text).toBe([
      'status: ok',
      'window: 2026-11-15 to 2026-11-21 (last_7_days, today partial) Asia/Kolkata',
      'as_of: 12 min ago',
      'note: Today is still in progress; say so far.',
      'label: Steady',
      'avgValue: 42.5',
      'summary: daysWithData=3, daysExpected=3',
      'items (date weekday value note):',
      '  2026-11-21 Sat 40 "so far"',
      '  2026-11-20 Fri 41 null',
      '  2026-11-19 Thu 42 null',
    ].join('\n'))
    expect(text.length).toBe(330)
  })

  it('a one-day window prints its date; no label and not partial prints no parentheses', () => {
    const o = outcome.ok({ a: 1 }, { window: { from: '2026-11-20', to: '2026-11-20', timezone: 'UTC', partialToday: false }, asOf: null })
    expect(renderers.lines(o, rc)).toBe('status: ok\nwindow: 2026-11-20 UTC\nas_of: unknown\na: 1')
  })

  it('error: the code on the status line, the message, then notes; no as_of', () => {
    const o: ToolOutcome<never> = { ...outcome.invalid('day must be a recent date'), guidance: ['Ask which day.'] }
    expect(renderers.lines(o, rc)).toBe('status: error (invalid_args)\nerror: day must be a recent date\nnote: Ask which day.')
  })

  it('empty lists, scalar lists, booleans and newlines in strings stay on one line each', () => {
    const o = outcome.ok({ none: [], tags: ['a', 'b'], flag: true, text: 'two\nlines' }, { window: null, asOf: null })
    expect(renderers.lines(o, rc)).toBe('status: ok\nas_of: unknown\nnone: none\ntags: a, b\nflag: true\ntext: two lines')
  })

  it('the truncation line names how many older items were left out', () => {
    const o = { ...okOutcome(1), truncated: { path: 'items', droppedItems: 9, kept: 'newest' as const, hardCut: false } }
    expect(renderers.lines(o, rc).split('\n').at(-1)).toBe('truncated: 9 older items left out')
  })

  it.each([
    ['2026-11-21T09:59:40Z', 'just now'],
    ['2026-11-21T09:48:00Z', '12 min ago'],
    ['2026-11-21T05:00:00Z', '5 h ago'],
    ['2026-11-18T10:00:00Z', '3 days ago'],
  ])('as_of %s reads %s', (asOf, words) => {
    expect(describeAge(asOf, NOW)).toBe(words)
  })

  it('is about 40 % shorter than compact JSON of the same envelope', () => {
    const o = okOutcome(7)
    const lines = renderers.lines(o, rc).length
    const json = renderers.json(o, rc).length
    expect(lines / json).toBeLessThan(0.7)
  })
})

describe('renderers.json and renderers.sentence', () => {
  it('json is the whole envelope, compact, on one line', () => {
    const o = okOutcome(1)
    const text = renderers.json(o, rc)
    expect(JSON.parse(text)).toEqual(o)
    expect(text).not.toContain('\n')
  })

  it('sentence prints the pack\'s prose for ok and falls back to lines otherwise', () => {
    const r = renderers.sentence((o: ToolOutcome<SeriesData>) => `Average ${o.data!.avgValue} over ${o.data!.items.length} days.`)
    expect(r(okOutcome(3), rc)).toBe('Average 42.5 over 3 days.')
    expect(r(outcome.empty({ window: null, asOf: null }), rc)).toBe('status: empty\nas_of: unknown')
  })
})

describe('renderer precedence', () => {
  const own = () => 'own'
  const byTool = () => 'byTool'
  const def = () => 'default'

  it('byTool > the definition\'s > config default > lines', () => {
    expect(pickRenderer('getSeries', own, { byTool: { getSeries: byTool }, default: def })(okOutcome(), rc)).toBe('byTool')
    expect(pickRenderer('getSeries', own, { byTool: { other: byTool }, default: def })(okOutcome(), rc)).toBe('own')
    expect(pickRenderer('getSeries', undefined, { default: def })(okOutcome(), rc)).toBe('default')
    expect(pickRenderer('getSeries', undefined, undefined)).toBe(renderers.lines)
  })

  it('a host switches every tool to json from config, without touching a tool', async () => {
    const { handle } = setup({ render: { default: renderers.json } })
    const t = handle.add(seriesTool())
    expect(JSON.parse(await call(t, { userId: 'alice' })).status).toBe('ok')
  })
})

describe('the budget', () => {
  it('drops the oldest items first (lists are newest first) and says so', () => {
    const o = okOutcome(31)
    const { text, outcome: fitted } = fitOutcome(o, renderers.lines, { ...rc, maxChars: 600 }, { listPaths: ['items'] })
    expect(text.length).toBeLessThanOrEqual(600)
    const kept = (fitted.data as SeriesData).items
    expect(kept[0].date).toBe('2026-11-21')
    expect(kept.length + fitted.truncated!.droppedItems).toBe(31)
    expect(fitted.truncated).toMatchObject({ path: 'items', kept: 'newest', hardCut: false })
    expect(text.split('\n').at(-1)).toBe(`truncated: ${fitted.truncated!.droppedItems} older items left out`)
  })

  it('keep: oldest drops from the front', () => {
    const { outcome: fitted } = fitOutcome(okOutcome(31), renderers.lines, { ...rc, maxChars: 600 }, { listPaths: ['items'], keep: 'oldest' })
    const kept = (fitted.data as SeriesData).items
    expect(kept.at(-1)!.date).toBe('2026-10-22')
    expect(fitted.truncated!.kept).toBe('oldest')
  })

  it('shortens the longest declared list first and keeps at least one item in each', () => {
    const data = { a: seriesData(20).items, b: seriesData(3).items }
    const o = outcome.ok(data, { window: null, asOf: null })
    const { outcome: fitted } = fitOutcome(o, renderers.lines, { ...rc, maxChars: 200 }, { listPaths: ['a', 'b'] })
    const d = fitted.data as typeof data
    expect(d.a.length).toBe(1)
    expect(d.b.length).toBe(1)
    expect(fitted.truncated).toMatchObject({ path: 'a', droppedItems: 21 })
  })

  it('a dotted path reaches a nested list', () => {
    const o = outcome.ok({ group: { items: seriesData(31).items } }, { window: null, asOf: null })
    const { text, outcome: fitted } = fitOutcome(o, renderers.json, { ...rc, maxChars: 800 }, { listPaths: ['group.items'] })
    expect(text.length).toBeLessThanOrEqual(800)
    expect(fitted.truncated!.path).toBe('group.items')
  })

  it('without a declared list, the last resort is a cut at a line break that keeps header and notes', () => {
    const { text, outcome: fitted } = fitOutcome(okOutcome(31), renderers.lines, { ...rc, maxChars: 300 }, undefined)
    expect(text.length).toBeLessThanOrEqual(300)
    expect(text.endsWith('\ntruncated: cut')).toBe(true)
    expect(text.startsWith('status: ok\nwindow:')).toBe(true)
    expect(text).toContain('note: Today is still in progress')
    expect(fitted.truncated).toMatchObject({ hardCut: true, droppedItems: 0 })
  })

  it('hardCut never exceeds the limit', () => {
    expect(hardCut('a'.repeat(50), 20).length).toBeLessThanOrEqual(20)
  })

  it('in the pipeline: 1,200 chars per result by default, `truncated_items` audited', async () => {
    const { handle, audit, events } = setup()
    const long = okOutcome(31)
    const data = { ...long.data!, items: long.data!.items.map(i => ({ ...i, note: 'a longer note per item' })) }
    const t = handle.add(seriesTool(() => ({ ...long, data })))
    const text = await call(t, { userId: 'alice' })
    expect(text.length).toBeLessThanOrEqual(1200)
    expect(audit.records[0].truncatedItems).toBe(events[0].outcome.truncated!.droppedItems)
    expect(audit.records[0].truncatedItems).toBeGreaterThan(0)
    expect(audit.records[0].resultRowCount).toBe(31 - audit.records[0].truncatedItems!)
  })

  it('a tool\'s own maxChars and the config\'s maxChars apply', async () => {
    const { handle } = setup({ outputBudget: { maxChars: 500 } })
    const a = handle.add(seriesTool(() => okOutcome(31)))
    const b = handle.add({ ...seriesTool(() => okOutcome(31)), name: 'getOther', budget: { maxChars: 900, listPaths: ['items'] } })
    expect((await call(a, { userId: 'alice' })).length).toBeLessThanOrEqual(500)
    const other = await call(b, { userId: 'alice' })
    expect(other.length).toBeLessThanOrEqual(900)
    expect(other.length).toBeGreaterThan(500)
  })

  it('3,600 chars per answer: later results get what is left, never less than the floor', async () => {
    const { handle } = setup()
    const t = handle.add(seriesTool(() => okOutcome(31)))
    const turn = handle.beginTurn()
    const lengths: number[] = []
    for (const p of ['this_week', 'last_7_days', 'last_30_days', undefined])
      lengths.push((await call(t, { userId: 'alice', ...(p ? { period: p } : {}) })).length)
    const { chars } = turn.end()
    expect(lengths.slice(0, 3).every(n => n <= 1200)).toBe(true)
    expect(lengths[3]).toBeLessThanOrEqual(Math.max(MIN_TURN_CHARS, 3600 - lengths[0] - lengths[1] - lengths[2]))
    expect(chars).toBe(lengths.reduce((a, b) => a + b, 0))
    expect(chars).toBeLessThanOrEqual(3600)
  })

  it('a small window result is not touched', async () => {
    const { handle, events } = setup()
    const t = handle.add(seriesTool(() => outcome.ok(seriesData(2), { window: WINDOW, asOf: null })))
    await call(t, { userId: 'alice' })
    expect(events[0].outcome.truncated).toBeNull()
  })
})
