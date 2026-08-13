/**
 * Zod contract for the firmware export payload (principle 60 — firmware
 * fixture governance).
 *
 * Models `FirmwareExport` from `./types.ts` EXACTLY, with `.strict()` on
 * every object so unknown keys fail parsing. This is the CI gate: when the
 * firmware team lands a new versioned fixture, any key the mapper doesn't
 * know about surfaces as a test failure — a PR-blocking event that forces a
 * deliberate schema + mapper update instead of a silent drop.
 *
 * `FIRMWARE_EXPORT_KEY_PATHS` is the same contract expressed as a key-path
 * set (`heartrate`, `heartrate[].timestamp`, ...) for the fixture key-diff
 * test in `__tests__/schema.test.ts`. Keep both in lockstep with
 * `FirmwareExport` — the key-diff test asserts the fixture corpus exercises
 * exactly this set.
 */

import type { FirmwareExport } from './types'
import { z } from 'zod'

/** Firmware timestamp: `"YYYY.MM.DD HH:MM:SS"` UTC wall-clock (see time.ts). */
const firmwareTimestamp = z.string().regex(
  /^\d{4}\.\d{1,2}\.\d{1,2} \d{1,2}:\d{1,2}:\d{1,2}$/,
  'expected firmware "YYYY.MM.DD HH:MM:SS" timestamp',
)

export const firmwareHRRowSchema = z.object({
  timestamp: firmwareTimestamp,
  singleHR: z.number(),
}).strict()

export const firmwareHRVRowSchema = z.object({
  timestamp: firmwareTimestamp,
  hrv: z.number().optional(),
  stress: z.number().optional(),
  heartRate: z.number().optional(),
  systolicBP: z.number().optional(),
  diastolicBP: z.number().optional(),
  vascularAging: z.number().optional(),
}).strict()

export const firmwareSpO2RowSchema = z.object({
  timestamp: firmwareTimestamp,
  automaticSpo2Data: z.number(),
}).strict()

export const firmwareTempRowSchema = z.object({
  timestamp: firmwareTimestamp,
  temperature: z.number(),
}).strict()

export const firmwareActivityRowSchema = z.object({
  timestamp: firmwareTimestamp,
  step: z.number(),
  calories: z.number(),
  distance: z.number(),
  arraySteps: z.array(z.number()).length(10),
}).strict()

export const firmwareSleepRowSchema = z.object({
  start: firmwareTimestamp,
  end: firmwareTimestamp,
  block_type: z.string(),
  confidence: z.number(),
  timestamp: firmwareTimestamp,
}).strict()

export const firmwareBatteryRowSchema = z.object({
  timestamp: firmwareTimestamp,
  battery: z.number(),
}).strict()

export const firmwareWeekdaysSchema = z.object({
  sunday: z.boolean(),
  monday: z.boolean(),
  Tuesday: z.boolean(),
  Wednesday: z.boolean(),
  Thursday: z.boolean(),
  Friday: z.boolean(),
  Saturday: z.boolean(),
}).strict()

/**
 * Mirrors `AutomaticMonitoring_J2301A` from the JStyle SDK. `dataType` is
 * the firmware enum (1=heartRate, 2=spo2, 3=temperature, 4=HRV) and is
 * translated away at the mapper boundary — see `mapper/ring-config.ts`.
 */
export const firmwareMonitoringWindowSchema = z.object({
  dataType: z.number().int(),
  intervalTime: z.number().int().nonnegative(),
  startTime_Hour: z.number().int(),
  startTime_Minutes: z.number().int(),
  endTime_Hour: z.number().int(),
  endTime_Minutes: z.number().int(),
  weeks: firmwareWeekdaysSchema,
  mode: z.number().int().optional(),
}).strict()

export const firmwareRingConfigSchema = z.object({
  automaticMonitoringData: z.array(firmwareMonitoringWindowSchema),
}).strict()

export const firmwareExportSchema = z.object({
  // Fixture files carry a human-readable `$comment`; real device exports
  // may omit it. Not part of `FirmwareExport` — stripped before mapping.
  $comment: z.string().optional(),
  heartrate: z.array(firmwareHRRowSchema),
  hrv_table: z.array(firmwareHRVRowSchema),
  spo2: z.array(firmwareSpO2RowSchema),
  temperature_table: z.array(firmwareTempRowSchema),
  activitydetails: z.array(firmwareActivityRowSchema),
  sleep_processed: z.array(firmwareSleepRowSchema),
  battery_table: z.array(firmwareBatteryRowSchema),
  ring: firmwareRingConfigSchema,
}).strict()

export type FirmwareExportParsed = z.infer<typeof firmwareExportSchema>

// Compile-time drift guard: a parsed export (minus the fixture-only
// `$comment`) must be assignable to the hand-written `FirmwareExport`.
type _AssertParsedMatchesType
  = Omit<FirmwareExportParsed, '$comment'> extends FirmwareExport ? true : never
const _assertParsedMatchesType: _AssertParsedMatchesType = true
void _assertParsedMatchesType

/**
 * Every key-path the schema knows about. Array elements are flattened as
 * `section[].key`. Used by the fixture key-diff test (principle 60).
 */
export const FIRMWARE_EXPORT_KEY_PATHS: ReadonlySet<string> = new Set([
  '$comment',
  'heartrate',
  'heartrate[].timestamp',
  'heartrate[].singleHR',
  'hrv_table',
  'hrv_table[].timestamp',
  'hrv_table[].hrv',
  'hrv_table[].stress',
  'hrv_table[].heartRate',
  'hrv_table[].systolicBP',
  'hrv_table[].diastolicBP',
  'hrv_table[].vascularAging',
  'spo2',
  'spo2[].timestamp',
  'spo2[].automaticSpo2Data',
  'temperature_table',
  'temperature_table[].timestamp',
  'temperature_table[].temperature',
  'activitydetails',
  'activitydetails[].timestamp',
  'activitydetails[].step',
  'activitydetails[].calories',
  'activitydetails[].distance',
  'activitydetails[].arraySteps',
  'sleep_processed',
  'sleep_processed[].start',
  'sleep_processed[].end',
  'sleep_processed[].block_type',
  'sleep_processed[].confidence',
  'sleep_processed[].timestamp',
  'battery_table',
  'battery_table[].timestamp',
  'battery_table[].battery',
  'ring',
  'ring.automaticMonitoringData',
  // AutomaticMonitoring_J2301A (JStyle SDK). `dataType` is the firmware
  // enum — 1=heartRate, 2=spo2, 3=temperature, 4=HRV — translated away at
  // the mapper boundary so it never reaches a warehouse column.
  'ring.automaticMonitoringData[].dataType',
  'ring.automaticMonitoringData[].intervalTime',
  'ring.automaticMonitoringData[].startTime_Hour',
  'ring.automaticMonitoringData[].startTime_Minutes',
  'ring.automaticMonitoringData[].endTime_Hour',
  'ring.automaticMonitoringData[].endTime_Minutes',
  'ring.automaticMonitoringData[].mode',
  'ring.automaticMonitoringData[].weeks',
  'ring.automaticMonitoringData[].weeks.sunday',
  'ring.automaticMonitoringData[].weeks.monday',
  'ring.automaticMonitoringData[].weeks.Tuesday',
  'ring.automaticMonitoringData[].weeks.Wednesday',
  'ring.automaticMonitoringData[].weeks.Thursday',
  'ring.automaticMonitoringData[].weeks.Friday',
  'ring.automaticMonitoringData[].weeks.Saturday',
])
