/**
 * `MockVitalsProvider` — the hooks, backed by fixtures.
 *
 * The point is not "some data to look at". It is that a screen can be driven
 * through **all five states of the A2 status contract** without a ring, a
 * warehouse, or a 30-day wait:
 *
 * ```tsx
 * <MockVitalsProvider status="learning">
 *   <BloodOxygenScreen />
 * </MockVitalsProvider>
 * ```
 *
 * `learning` in particular is unreachable in practice — it needs a user
 * between day 1 and day 30 — and it is the state screens get wrong, because
 * there IS data and the chart renders while `verdict` is null.
 *
 * The hook signatures here are the ones the real package will export. A screen
 * built against this provider compiles unchanged against the real hooks; only
 * the provider it is wrapped in changes.
 */

import type { ReactNode } from 'react'
import type {
  HrvAlertSetting,
  Spo2DayView,
  TrendRange,
  VitalAlertSetting,
  VitalKey,
  VitalStatus,
  VitalTrendView,
} from '../types'

import * as React from 'react'
import { spo2DayEmpty, spo2DayLearning, spo2DayReady, spo2TrendReady } from './fixtures'

interface MockContextValue {
  status: VitalStatus
}

const MockContext = React.createContext<MockContextValue | null>(null)

export interface MockVitalsProviderProps {
  children: ReactNode
  /** Drives every hook. Defaults to the fully populated case. */
  status?: VitalStatus
}

export function MockVitalsProvider({
  children,
  status = 'ready',
}: MockVitalsProviderProps): React.JSX.Element {
  const value = React.useMemo(() => ({ status }), [status])
  return <MockContext.Provider value={value}>{children}</MockContext.Provider>
}

function useMockStatus(): VitalStatus {
  const ctx = React.useContext(MockContext)
  if (!ctx) {
    // Loud, not a silent default. A screen rendering mock data because it
    // forgot the provider is the kind of thing that reaches a demo.
    throw new Error(
      '@mongrov/vitals-hooks/mock: hook used outside <MockVitalsProvider>. '
      + 'Wrap the screen, or import the real hooks from @mongrov/vitals-hooks.',
    )
  }
  return ctx.status
}

/**
 * `offset` is accepted and ignored — the mock returns the same day for any
 * offset on purpose, so a screen that paginates still renders. Do not read
 * anything into the values changing or not changing between days.
 */
export function useSpO2Day(_offset: number = 0): Spo2DayView {
  const status = useMockStatus()
  switch (status) {
    case 'ready':
      return spo2DayReady()
    case 'learning':
      return spo2DayLearning()
    default:
      return spo2DayEmpty(status)
  }
}

export function useSpO2Trend(
  range: TrendRange = 'week',
  _offset: number = 0,
): VitalTrendView {
  const status = useMockStatus()
  const base = spo2TrendReady(range)
  if (status === 'ready')
    return base
  return {
    ...base,
    status,
    verdict: null,
    worthALook: null,
    days: status === 'learning' ? base.days : [],
  }
}

/**
 * A7 — optimistic `setValue`, nothing persists until `save()`.
 *
 * The mock keeps the same contract: the value moves live, and `save()`
 * resolves with the toast text to render verbatim.
 */
export function useVitalAlertSetting(vital: 'spo2' | 'temp' | 'hr'): VitalAlertSetting
export function useVitalAlertSetting(vital: 'hrv'): HrvAlertSetting
export function useVitalAlertSetting(
  vital: VitalKey,
): VitalAlertSetting | HrvAlertSetting {
  useMockStatus()
  const [spo2Value, setSpo2Value] = React.useState(90)
  const [dropMs, setDropMs] = React.useState(10)
  const [dropDays, setDropDays] = React.useState(3)
  const [notifyEnabled, setNotify] = React.useState(true)

  if (vital === 'hrv') {
    return {
      dropMs,
      dropDays,
      // Pre-composed — the screen renders the sentence and wires the steppers
      // (B3). It never assembles this itself.
      settingSentence: `Tell me when I'm below my usual by ${dropMs} ms for ${dropDays} days`,
      notifyEnabled,
      setDropMs,
      setDropDays,
      setNotify,
      save: async () => ({ toast: 'Alert settings saved' }),
    }
  }

  return {
    value: spo2Value,
    displayLabel: `My safe level ${spo2Value}%`,
    min: 86,
    max: 94,
    step: 1,
    notifyEnabled,
    setValue: setSpo2Value,
    setNotify,
    save: async () => ({ toast: 'Safe level saved' }),
  }
}
