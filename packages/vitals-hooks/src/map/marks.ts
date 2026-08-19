/**
 * Registry slot rows → `Mark[]` on the cadence grid.
 *
 * The first piece of the mapping layer, kept pure and separate from the hook
 * because the contract's hardest chart rules are all here and none of them
 * need React or a query to test.
 *
 * Three rules that are easy to get wrong, and all three are A6/A9:
 *
 *   1. `marks.length` ALWAYS equals `cadence.slotCount`. The query returns
 *      only slots it has rows for; the grid is dense. A screen that iterates
 *      marks is drawing the day, so a missing slot silently shortens it.
 *   2. A gap is a mark with `value: null`, never an absent mark. The screen
 *      must render the gap slot and must not bridge across it — which it
 *      cannot do if the slot is not there to render.
 *   3. `attention`/`alert` tone only where `isException`. A5: a Normal day
 *      renders with zero amber, and the hook is what guarantees it.
 */

import type { Mark, MarkContext, Tone } from '../types'

/** One row as the registry returns it — sparse, keyed by slot index. */
export interface SlotRow {
  slot_index: number
  value_avg: number | null
  context: string
}

export interface MarkMapOptions {
  slotCount: number
  minutesPerSlot: number
  /** Crossing this makes a mark an exception. Absent ⇒ nothing is hot. */
  exceptionBelow?: number
  exceptionAbove?: number
  /** value → locked zone id. Gaps never reach it. */
  zoneFor: (value: number) => string
  /** Zone id used for a slot with no reading. */
  gapZone?: string
}

/** Display-ready wall clock for a slot, e.g. "4:30 AM". */
export function slotLabel(slot: number, minutesPerSlot: number): string {
  const total = slot * minutesPerSlot
  const hour24 = Math.floor(total / 60) % 24
  const minute = total % 60
  const suffix = hour24 < 12 ? 'AM' : 'PM'
  const hour12 = hour24 % 12 === 0 ? 12 : hour24 % 12
  return `${hour12}:${String(minute).padStart(2, '0')} ${suffix}`
}

function normaliseContext(raw: string): MarkContext {
  return raw === 'asleep' || raw === 'active' ? raw : 'awake'
}

/**
 * Tone follows the exception, not the value.
 *
 * A reading can sit in a lower zone without crossing the user's level — that
 * is information, not a warning, and it renders neutral. Only a crossing goes
 * hot, which is what keeps a Normal day free of amber.
 */
function toneFor(isException: boolean, isGap: boolean): Tone {
  if (isGap)
    return 'neutral'
  return isException ? 'attention' : 'good'
}

export function mapMarks(rows: readonly SlotRow[], options: MarkMapOptions): Mark[] {
  const {
    slotCount,
    minutesPerSlot,
    exceptionBelow,
    exceptionAbove,
    zoneFor,
    gapZone = 'gap',
  } = options

  // Index the sparse rows so the dense grid can be built in one pass rather
  // than scanning per slot.
  const bySlot = new Map<number, SlotRow>()
  for (const row of rows) {
    const slot = Number(row.slot_index)
    // Out-of-range slots would silently vanish in the grid build below; drop
    // them here so the count stays exact and the cause stays visible.
    if (Number.isInteger(slot) && slot >= 0 && slot < slotCount)
      bySlot.set(slot, row)
  }

  return Array.from({ length: slotCount }, (_, slot) => {
    const row = bySlot.get(slot)
    const raw = row?.value_avg
    const value = raw === null || raw === undefined ? null : Number(raw)
    const isGap = value === null || !Number.isFinite(value)

    const isException = !isGap && (
      (exceptionBelow !== undefined && value < exceptionBelow)
      || (exceptionAbove !== undefined && value > exceptionAbove)
    )

    return {
      slot,
      localTime: slotLabel(slot, minutesPerSlot),
      value: isGap ? null : value,
      context: normaliseContext(row?.context ?? 'awake'),
      zone: isGap ? gapZone : zoneFor(value),
      tone: toneFor(isException, isGap),
      isException,
    } satisfies Mark
  })
}
