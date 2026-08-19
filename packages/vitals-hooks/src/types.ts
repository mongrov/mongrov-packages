/**
 * The UX Interface Contract, as types.
 *
 * Source: `techspec/references/ZivaOne Vitals - UX Interface Contract v1.4.md`.
 * **The types ARE the contract** — a screen that compiles against these is
 * rendering the fields the contract names, and a field renamed here is a
 * breaking change to every screen.
 *
 * ## Why so many `string`s
 *
 * Almost every user-facing value is a pre-composed string, not a number plus a
 * unit or an enum plus a lookup. That is A4, the render-verbatim rule: the
 * screen must not write `value + '%'`, and must not pick a word with an
 * if/else. `heroValue: "96"` and `heroUnit: "%"` arrive separately and already
 * formatted; `verdict.word` is the word.
 *
 * The corollary is that this file deliberately does NOT export helpers for
 * composing those strings. If a screen needs one, the contract is incomplete
 * and the fix is here, not there.
 *
 * ## Tones, not colours
 *
 * A5: hooks emit semantic tone; the screen maps tone to DS 2.5 colour. There
 * is no colour anywhere in this file, on purpose.
 */

/**
 * A4/A9 marker for strings the screen must render character-for-character.
 *
 * Purely documentary — it is `string` at runtime — but it makes the boundary
 * visible at every field it annotates, which is where reviewers look.
 */
export type Verbatim = string

/**
 * A2 — identical for all vitals, all hooks. The hook decides which applies;
 * the screen never infers it.
 *
 * `learning` is the subtle one: there IS data and it renders, but the hook
 * returns no verdicts and population rails only.
 */
export type VitalStatus
  = | 'loading'
    | 'no-sensor'
    | 'first-day'
    | 'learning'
    | 'ready'

/** A5 — semantic only. `attention`/`alert` appear only when the hook says so. */
export type Tone = 'good' | 'neutral' | 'attention' | 'alert'

export type VitalKey = 'spo2' | 'temp' | 'hrv' | 'stress' | 'hr'

/** A6 — context bands. `neutral` context must never use the warning family. */
export type MarkContext = 'asleep' | 'active' | 'awake'

/** A6 — one point on the cadence grid. Gaps are marks with a null value. */
export interface Mark {
  slot: number
  /** Display-ready, e.g. "4:00 AM". Never a timestamp to format. */
  localTime: Verbatim
  /** `null` = gap. Render the gap slot; never bridge it (A9). */
  value: number | null
  context: MarkContext
  /** The vital's locked zone id — see the per-vital sections. */
  zone: string
  tone: Tone
  /** Crossed the user's level. Only these may colour hot. */
  isException: boolean
}

export interface Band {
  kind: 'asleep' | 'active'
  fromSlot: number
  toSlot: number
}

/**
 * A6 — style rule: facts are solid, draggable settings are dashed.
 *
 * A line absent from the array must not exist on screen. HRV never sends a
 * draggable line, and the period average is never a line — it lives in
 * `heroSub`.
 */
export interface ReferenceLine {
  id: string
  value: number
  y: 'fromValue'
  label: Verbatim
  tone: Tone
  style: 'solid' | 'dashed'
  draggable?: boolean
}

/**
 * Slot count comes from here, never hard-coded — next-gen rings change it
 * (A6, A9).
 */
export interface Cadence {
  slotCount: number
  minutesPerSlot: number
  /** e.g. "every 30 minutes" — for the ? sheet. */
  note: Verbatim
}

export interface Verdict {
  word: Verbatim
  tone: Tone
}

export interface SummarySegment {
  count: number
  label: Verbatim
  tone: Tone
}

export interface SummaryBar {
  segments: SummarySegment[]
  headline: Verbatim
  subline: Verbatim
}

export interface ContextRow {
  label: Verbatim
  value: Verbatim
}

export interface LegendEntry {
  label: Verbatim
  tone: Tone
  zone?: string
}

export interface WorthALook {
  text: Verbatim
  zivaPrompt: string
}

/** Enumerated and SQL-backed. A screen never adds one (A9). */
export interface Factor {
  key: string
  title: Verbatim
  body: Verbatim
}

export interface Compare {
  bandLo: number
  bandHi: number
  marker: number
  bandLabel: Verbatim
  caption: Verbatim
}

export interface TableColumn {
  key: string
  label: Verbatim
}

export interface TableRow {
  cells: Record<string, Verbatim>
  /** Pre-worded — the screen never derives a status word. */
  status: Verbatim
  tone: Tone
}

export interface VitalTable {
  columns: TableColumn[]
  rows: TableRow[]
  subtitle: Verbatim
}

export interface Report {
  rows: Verbatim[]
  footnote: Verbatim
  cta: Verbatim
}

export interface ZoneRow {
  zone: string
  label: Verbatim
  range: Verbatim
}

export interface Explainer {
  title: Verbatim
  body: Verbatim
  zoneRows: ZoneRow[]
  cadenceNote: Verbatim
  /** The ONLY field where temperature's "fever" may appear (B2). */
  doctorNote: Verbatim
}

export interface Day30Banner {
  title: Verbatim
  body: Verbatim
  dismiss: () => Promise<void>
}

/**
 * A3 — mandatory on every Day view. Placement is the screen's choice;
 * dropping it is an auto-reject. It is the last SYNC time, not a clock.
 */
export interface UpdatedAt {
  label: Verbatim
}

/** Copy for the non-ready states, so the screen never writes its own. */
export interface VitalMeta {
  vital: VitalKey
  /** e.g. "Heart Rate Variability" — render in full, never abbreviated (B3). */
  displayName: Verbatim
  noSensor: Verbatim
  firstRun: { title: Verbatim, steps: Verbatim[] }
  learningChip: Verbatim
}

/** Fields every Day view carries (A8). */
export interface VitalDayView {
  status: VitalStatus
  meta: VitalMeta

  periodLabel: Verbatim
  updatedAt: UpdatedAt

  heroValue: Verbatim
  heroUnit: Verbatim
  heroCaption: Verbatim
  heroSub: Verbatim
  /** Absent while `learning` — the hook returns no verdicts before Day 30. */
  verdict: Verdict | null

  marks: Mark[]
  bands: Band[]
  axis: Verbatim[]
  referenceLines: ReferenceLine[]
  cadence: Cadence

  summaryBar: SummaryBar
  contextRows: ContextRow[]
  legend: LegendEntry[]

  /** `null` ⇒ section hidden. */
  worthALook: WorthALook | null
  /** `null` or empty ⇒ hidden. */
  factors: Factor[] | null
  /** In short — and the read-aloud script. */
  narrative: Verbatim

  compare: Compare
  table: VitalTable
  report: Report
  zivaPrompt: string
  day30Banner: Day30Banner | null
  explainer: Explainer
}

/** One day's row in a trend view. `core` is never derived screen-side (A6). */
export interface TrendDay {
  day: Verbatim
  avg: number | null
  lo: number | null
  hi: number | null
  core: [number, number] | null
  tone: Tone
}

export interface RasterCell {
  day: Verbatim
  hour: number
  value: number | null
  zone: string
  tone: Tone
  flagged?: boolean
}

/** B4 — positions within the night, never clock times. */
export interface SleepWindowNight {
  night: Verbatim
  slices: (number | null)[]
}

/** B5 — its own resting-only axis; never merged into the main chart. */
export interface RhrDrift {
  points: { day: Verbatim, value: number }[]
  baselineValue: number
  baselineLabel: Verbatim
  caption: Verbatim
}

export type TrendRange = 'week' | 'month'

/**
 * Trend views. Note there is no `updatedAt` — A3 says trends omit it and the
 * screen must not invent one.
 */
export interface VitalTrendView {
  status: VitalStatus
  meta: VitalMeta

  periodLabel: Verbatim
  range: TrendRange

  heroValue: Verbatim
  heroUnit: Verbatim
  heroCaption: Verbatim
  heroSub: Verbatim
  verdict: Verdict | null

  days: TrendDay[]
  axis: Verbatim[]
  referenceLines: ReferenceLine[]

  summaryBar: SummaryBar
  legend: LegendEntry[]
  worthALook: WorthALook | null
  narrative: Verbatim
  table: VitalTable
  report: Report
  zivaPrompt: string
  explainer: Explainer

  /** Stress always; HRV may (B4). */
  rasterCells?: RasterCell[]
  /** SpO₂ trend addendum (B4). */
  sleepWindow?: SleepWindowNight[]
  /** Heart Rate trends only (B5). */
  rhrDrift?: RhrDrift | null
}

/**
 * A7 — the settings write path.
 *
 * `setValue` is optimistic: the line and label move live, nothing persists
 * until `save()`. `save()` resolves with the toast text to render verbatim.
 */
export interface VitalAlertSetting {
  value: number
  displayLabel: Verbatim
  min: number
  max: number
  step: number
  notifyEnabled: boolean
  setValue: (next: number) => void
  setNotify: (enabled: boolean) => void
  save: () => Promise<{ toast: Verbatim }>
}

/**
 * B3 — HRV is the exception: two steppers and a pre-composed sentence, and
 * never a draggable line, because there is no absolute threshold UI for this
 * vital (decision D3).
 */
export interface HrvAlertSetting {
  dropMs: number
  dropDays: number
  settingSentence: Verbatim
  notifyEnabled: boolean
  setDropMs: (next: number) => void
  setDropDays: (next: number) => void
  setNotify: (enabled: boolean) => void
  save: () => Promise<{ toast: Verbatim }>
}

/** SpO₂ day adds a deepest-dip callout (B1). */
export interface Spo2DayView extends VitalDayView {
  deepestDip: {
    valueLabel: Verbatim
    timeLabel: Verbatim
    deltaLabel: Verbatim
  } | null
}

/** Temperature marks are dots with straight segments broken at gaps (B2). */
export interface TempDayView extends VitalDayView {
  connectSegments: true
}

/** HRV marks are dots with no connectors (B3). */
export interface HrvDayView extends VitalDayView {
  connectSegments: false
}
