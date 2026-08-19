/**
 * Mock data satisfying the contract.
 *
 * These exist so the screen side can build against the real field names before
 * the query wiring lands, and — more importantly — so it can build all FIVE
 * status states. `ready` is the easy one; `learning` is the one screens get
 * wrong, because there IS data and it renders, but the hook returns no verdict
 * and population rails only (A2).
 *
 * Values are plausible, not real. Anything a screen renders verbatim is
 * written the way the copy packs write it, so a screen built against the mock
 * does not silently depend on a shape the real hooks will not produce.
 */

import type {
  Cadence,
  Mark,
  Spo2DayView,
  VitalDayView,
  VitalKey,
  VitalMeta,
  VitalStatus,
  VitalTrendView,
} from '../types'

const SPO2_CADENCE: Cadence = {
  slotCount: 48,
  minutesPerSlot: 30,
  note: 'Your ring takes a reading about every 30 minutes.',
}

export const META: Record<VitalKey, VitalMeta> = {
  spo2: {
    vital: 'spo2',
    displayName: 'Blood Oxygen',
    noSensor: 'This ring doesn\'t measure blood oxygen.',
    firstRun: {
      title: 'Let\'s get your first night',
      steps: ['Wear your ring overnight', 'Sync in the morning', 'Check back here'],
    },
    learningChip: 'Learning your usual',
  },
  temp: {
    vital: 'temp',
    displayName: 'Temperature',
    noSensor: 'This ring doesn\'t measure temperature.',
    firstRun: {
      title: 'Let\'s get your first night',
      steps: ['Wear your ring overnight', 'Sync in the morning', 'Check back here'],
    },
    learningChip: 'Learning your usual',
  },
  hrv: {
    vital: 'hrv',
    // Full words — never abbreviated in the title (B3).
    displayName: 'Heart Rate Variability',
    noSensor: 'This ring doesn\'t measure heart rate variability.',
    firstRun: {
      title: 'Let\'s get your first night',
      steps: ['Wear your ring overnight', 'Sync in the morning', 'Check back here'],
    },
    learningChip: 'Learning your usual',
  },
  stress: {
    vital: 'stress',
    displayName: 'Stress',
    noSensor: 'This ring doesn\'t measure stress.',
    firstRun: {
      title: 'Let\'s get your first day',
      steps: ['Wear your ring today', 'Sync this evening', 'Check back here'],
    },
    learningChip: 'Learning your usual',
  },
  hr: {
    vital: 'hr',
    displayName: 'Heart Rate',
    noSensor: 'This ring doesn\'t measure heart rate.',
    firstRun: {
      title: 'Let\'s get your first day',
      steps: ['Wear your ring today', 'Sync this evening', 'Check back here'],
    },
    learningChip: 'Learning your usual',
  },
}

/** 48 slots, with a deliberate gap and one exception so both render paths run. */
function spo2Marks(): Mark[] {
  return Array.from({ length: SPO2_CADENCE.slotCount }, (_, slot) => {
    const hour = Math.floor(slot / 2)
    const minute = slot % 2 === 0 ? '00' : '30'
    const ampm = hour < 12 ? 'AM' : 'PM'
    const h12 = hour % 12 === 0 ? 12 : hour % 12

    // Slots 20–23 are a gap: the ring was off the finger.
    const isGap = slot >= 20 && slot <= 23
    // One genuine dip below the safe level, in the early hours.
    const isDip = slot === 7

    const value = isGap ? null : isDip ? 88 : 95 + (slot % 4)

    return {
      slot,
      localTime: `${h12}:${minute} ${ampm}`,
      value,
      context: slot < 12 ? 'asleep' : slot >= 28 && slot <= 32 ? 'active' : 'awake',
      zone: isGap ? 'gap' : isDip ? 'low' : value! >= 95 ? 'typical' : 'slightly-low',
      tone: isGap ? 'neutral' : isDip ? 'attention' : 'good',
      isException: isDip,
    } satisfies Mark
  })
}

function spo2Explainer(): VitalDayView['explainer'] {
  return {
    title: 'About blood oxygen',
    body: 'Your ring measures how much oxygen your blood is carrying. Slightly '
      + 'lower readings during sleep are completely normal.',
    zoneRows: [
      { zone: 'typical', label: 'Typical', range: '95% and above' },
      { zone: 'slightly-low', label: 'Slightly low', range: '90–94%' },
      { zone: 'low', label: 'Below 90', range: 'under 90%' },
    ],
    cadenceNote: SPO2_CADENCE.note,
    doctorNote: 'If low readings keep up night after night, it\'s worth '
      + 'mentioning to your doctor.',
  }
}

const SPO2_TABLE: VitalDayView['table'] = {
  columns: [
    { key: 'time', label: 'Time' },
    { key: 'value', label: 'Reading' },
  ],
  rows: [
    { cells: { time: '3:30 AM', value: '88%' }, status: 'Below your safe level', tone: 'attention' },
    { cells: { time: '9:00 AM', value: '97%' }, status: 'Normal', tone: 'good' },
  ],
  subtitle: 'Every reading from today',
}

/** A fully populated `ready` SpO₂ day. */
export function spo2DayReady(): Spo2DayView {
  return {
    status: 'ready',
    meta: META.spo2,
    periodLabel: 'Today',
    updatedAt: { label: 'updated 9:41 PM' },

    heroValue: '96',
    heroUnit: '%',
    heroCaption: 'Average',
    heroSub: 'average 96%',
    verdict: { word: 'Normal', tone: 'good' },

    marks: spo2Marks(),
    bands: [
      { kind: 'asleep', fromSlot: 0, toSlot: 11 },
      { kind: 'active', fromSlot: 28, toSlot: 32 },
    ],
    axis: ['12 AM', '6 AM', '12 PM', '6 PM', 'Now'],
    referenceLines: [
      {
        id: 'safe-level',
        value: 90,
        y: 'fromValue',
        label: 'My safe level 90%',
        tone: 'attention',
        style: 'dashed',
        draggable: true,
      },
    ],
    cadence: SPO2_CADENCE,

    summaryBar: {
      segments: [
        { count: 40, label: 'Typical', tone: 'good' },
        { count: 3, label: 'Slightly low', tone: 'neutral' },
        { count: 1, label: 'Below 90', tone: 'attention' },
      ],
      headline: 'Steady all day',
      subline: '40 of 44 readings sat in your typical range.',
    },
    contextRows: [
      { label: 'Asleep avg', value: '95%' },
      { label: 'Awake avg', value: '97%' },
    ],
    legend: [
      { label: 'Typical', tone: 'good', zone: 'typical' },
      { label: 'Slightly low', tone: 'neutral', zone: 'slightly-low' },
      { label: 'Below 90', tone: 'attention', zone: 'low' },
    ],

    worthALook: {
      text: '1 reading dipped below your safe level of 90% in the early hours. '
        + 'Not a concern on its own. Worth a look if it repeats.',
      zivaPrompt: 'ziva://ask?topic=spo2-dip',
    },
    factors: [
      {
        key: 'sleep_position',
        title: 'How you slept',
        body: 'Sleeping on your side or front can press on the finger and lower a reading.',
      },
    ],
    narrative: 'Normal overall — averaging 96%, with 1 reading that dipped below '
      + 'your safe level of 90% in the early hours. One night like this is common. '
      + 'We\'ll keep watching.',

    compare: {
      bandLo: 93,
      bandHi: 99,
      marker: 96,
      bandLabel: 'Your usual 93–99%',
      caption: 'Today sat right in your usual range.',
    },
    table: SPO2_TABLE,
    report: {
      rows: ['Average 96%', 'Lowest 88% at 3:30 AM', '1 reading below your safe level'],
      footnote: 'Not a medical device. Trends only.',
      cta: 'Share with my doctor',
    },
    zivaPrompt: 'ziva://ask?topic=spo2-today',
    day30Banner: null,
    explainer: spo2Explainer(),

    deepestDip: {
      valueLabel: '88%',
      timeLabel: '3:30 AM',
      deltaLabel: '8% below your usual',
    },
  }
}

/**
 * The `learning` state — the one screens get wrong.
 *
 * There IS data and the chart renders, but `verdict` is null, there is no
 * `worthALook`, and the compare band is population rails rather than the
 * user's own. The chip copy lives in `meta.learningChip`.
 */
export function spo2DayLearning(): Spo2DayView {
  const ready = spo2DayReady()
  return {
    ...ready,
    status: 'learning',
    verdict: null,
    worthALook: null,
    factors: null,
    heroSub: 'average 96%',
    narrative: 'We\'re still learning your usual — 12 of 30 days so far. '
      + 'Today averaged 96%.',
    compare: {
      bandLo: 95,
      bandHi: 100,
      marker: 96,
      bandLabel: 'Typical range 95–100%',
      caption: 'We\'ll show your own range once we\'ve seen 30 days.',
    },
    day30Banner: {
      title: 'Learning your usual',
      body: '12 of 30 days so far. Keep wearing your ring overnight.',
      dismiss: async () => {},
    },
    deepestDip: null,
  }
}

/** Statuses with nothing to render — the hook still returns meta for the copy. */
export function spo2DayEmpty(status: Extract<VitalStatus, 'loading' | 'no-sensor' | 'first-day'>): Spo2DayView {
  const ready = spo2DayReady()
  return {
    ...ready,
    status,
    verdict: null,
    worthALook: null,
    factors: null,
    marks: [],
    bands: [],
    day30Banner: null,
    deepestDip: null,
  }
}

export function spo2TrendReady(range: 'week' | 'month'): VitalTrendView {
  const dayCount = range === 'week' ? 7 : 30
  return {
    status: 'ready',
    meta: META.spo2,
    periodLabel: range === 'week' ? 'This week' : 'This month',
    range,
    heroValue: '96',
    heroUnit: '%',
    heroCaption: 'Average',
    heroSub: 'average 96%',
    verdict: { word: 'Normal', tone: 'good' },
    days: Array.from({ length: dayCount }, (_, i) => ({
      day: `Day ${i + 1}`,
      avg: 95 + (i % 3),
      lo: 90 + (i % 3),
      hi: 99,
      core: [94, 98],
      tone: 'good',
    })),
    axis: range === 'week'
      ? ['Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat', 'Sun']
      : ['Week 1', 'Week 2', 'Week 3', 'Week 4'],
    referenceLines: [
      {
        id: 'usual',
        value: 96,
        y: 'fromValue',
        label: 'Your usual 96%',
        tone: 'neutral',
        style: 'solid',
      },
    ],
    summaryBar: {
      segments: [{ count: dayCount, label: 'In range', tone: 'good' }],
      headline: 'Steady week',
      subline: 'Your nightly average held around 96%.',
    },
    legend: [{ label: 'In range', tone: 'good', zone: 'typical' }],
    worthALook: null,
    narrative: 'Steady week — your nightly average held around 96%, right in '
      + 'your usual range.',
    table: SPO2_TABLE,
    report: {
      rows: [`Average 96% over ${dayCount} days`],
      footnote: 'Not a medical device. Trends only.',
      cta: 'Share with my doctor',
    },
    zivaPrompt: 'ziva://ask?topic=spo2-trend',
    explainer: spo2Explainer(),
  }
}
