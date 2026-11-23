# `@mongrov/analytics/rules`

Structured threshold rule engine over the analytics warehouse. Rules are
authored as Zod-typed objects (or TOML), compiled to parameterized DuckDB
SQL, evaluated on each batch and on a schedule, throttled through the KV
store, and delivered fire-and-forget through an emitter. The engine never
mutates warehouse state.

The engine knows no metric, table or context of its own. Metrics come from
the registered packs (`pack.metrics`), named sample contexts and per-metric
policy from `pack.rules` (`RulePack`). Register packs before parsing rules.

```ts
import { createRulesEngine, parseCatalog } from '@mongrov/analytics/rules'

const engine = createRulesEngine({
  analytics, // AnalyticsEngine
  storage, // KVStore
  familyMembersProvider, // (ctx) => Promise<string[]>
  brand: 'acme',
  familyId: currentFamilyId,
  userTimezoneProvider, // optional: (userId) => Promise<IANA zone | undefined>  ($tz)
  userDeviceProvider, // optional: (userId) => Promise<device id | undefined>  ($deviceId)
})

await engine.register(parseCatalog(catalogToml, { name: 'acme' }))
engine.on('violation', v => notify(v))

// Wire into the sync pipeline (createSyncManager({ rulesEngine }) does this
// once per batch), and/or a schedule:
await engine.evaluateOnBatch({ affectedUserIds, affectedTables })
await engine.evaluateScheduled()
```

## Files

| File | What |
|---|---|
| `schema.ts` | `RuleSchema`, `TargetSchema`, `ThrottleSchema`, `WINDOWS`, `AGGREGATIONS`, `COMPARES`, `SEVERITIES`, `RuleValidationError` |
| `validator.ts` | `validateRule`, `allowedWindowsFor` — checks that need the registered packs |
| `contexts.ts` | `ruleContextNames`, `contextJoin` — `any` plus the packs' contexts |
| `compiler.ts`, `compiler-cache.ts` | `compileRule` → `{ sql, params }`; memoized per registry revision |
| `registry.ts`, `throttle.ts`, `emitter.ts`, `evaluator.ts` | rule set, per-user throttle, violation fan-out, evaluation |
| `factory.ts` | `createRulesEngine` |
| `defaults/loader.ts` | `parseCatalog` — TOML catalogs (`[[rule]]` entries) |
| `hooks/` | `useRuleViolations`, `useRuleRegistry` |

## Rule schema

```ts
{
  id: string,
  brand?: string,               // defaults to the engine's brand
  name: string,
  description?: string,
  metric: string,               // a metric a registered pack exposes
  window: '1h' | '6h' | '24h' | '3d' | '7d' | '30d',
  aggregation: 'avg' | 'min' | 'max' | 'sum' | 'last' | 'count',
  compare: 'less_than' | 'greater_than' | 'less_than_or_equal'
    | 'greater_than_or_equal' | 'equals' | 'not_equals' | 'between',
  context: string,              // 'any' (default) or a pack's context
  consecutive?: number,         // n adjacent breaching samples
  cadence: 'reading' | 'day',   // what consecutive counts (default reading)
  allowSingleDay?: boolean,
  consecutiveKey?: string,      // KV setting overriding consecutive
  minDays?: number,             // distinct local days with data required
  target:
    | { type: 'absolute', value }
    | { type: 'range', min, max }
    | { type: 'baseline_percent', windowDays, percent }
    | { type: 'baseline_stddev', windowDays, stddevs }
    | { type: 'baseline_offset', windowDays, offset, direction, offsetKey?,
        percentile?: 'p05' | 'p10' | 'p50' | 'p90' | 'p95' }   // default p50
    | { type: 'user_setting', key, defaultValue }
    | { type: 'phase_band', band, windowDays, defaultLo?, defaultHi?, scaleKey?, scales?, defaultScale? },
  severity: 'info' | 'warn' | 'critical',
  throttle: { minGapMinutes, maxPerDay },  // defaults 60 / 3
  rawSql?: string,              // escape hatch — allow-listed placeholders only
  rawSqlParams?: string[],
  rawSqlSettings?: Record<string, { key, defaultValue: number | string,
                                     type?: 'number' | 'string' }>, // $name ← user setting
  exposureOverride?: boolean,   // required when rawSql reads collected_only columns
}
```

Targets, briefly:

- `baseline_percent` / `baseline_stddev` compare against a mean computed
  inline over the window.
- `baseline_offset` compares against the user's stored baseline
  (`user_baseline.p50`, or the column `percentile` names) minus or plus a
  fixed offset. `percentile: 'p90'` with `direction: 'above'` fires above the
  top of the user's usual range rather than its middle.
- `user_setting` reads the threshold from a KV setting at evaluation time;
  the key must be registered in the packs' `RuleSettings`.
- `phase_band` (the name is historical; it means *a stored per-user band*)
  compares each reading against a band whose two edges are stored in
  `user_baseline` as `${band}_lo` / `${band}_hi`. Optional population edges
  (`defaultLo` / `defaultHi`, both or neither) apply until the user's own are
  stored; without them the rule stays silent until then. `scaleKey` /
  `scales` widen or narrow the band about its midpoint by a named setting.

A rule is checked when parsed (`RuleSchema`, against the packs registered
then) and again at `register()` (`validateRule`, plus each pack's
`rules.validate` and `rules.admit`). A bad rule throws `RuleValidationError`
before any SQL is compiled.

## Windows

`allowedWindowsFor(metric)`: a pack's explicit `rules.windows[metric]` if it
declares one; otherwise every window at least twice the metric's
`sampling_minutes` (and `consecutive` times that for run-length rules). A
metric sampled once per session (`sampling_minutes: 'per_session'`) allows
`3d`, `7d` and `30d`.

## Contexts

`context: 'any'` uses every sample in the window. Any other name is a JOIN a
pack registers (`pack.rules.contexts[name]({ table, qualityRelation })`),
restricting the metric relation `m` — the aggregate is computed over those
samples only, not computed over everything and then filtered.

## Compilation

`compileRule(rule)` returns `{ sql, params, description }`:

- `$userId`, `$brand`, `$familyId` and every threshold are bound
  parameters, never concatenated.
- Table and column identifiers come from the metric definition, are
  sanitized (`sanitizeIdent`) and inlined.
- Rules read the `v_<table>` union views (`viewFor`), or a pack's clean
  relation when it declares quality views.
- `rawSql` is passed through with an allow-list check: every `$name`
  placeholder must be `userId`, `brand`, `familyId`, `tz`, `deviceId`, a
  `rawSqlSettings` name, or declared in `rawSqlParams`.

### `rawSql` binds

A pack can write a rule on the same SQL its screens run — grouped by local
hour or local day, over a session table, on a value it computes — with the
user's zone and settings as bound parameters, never interpolated:

- `$tz` — the user's IANA zone from `userTimezoneProvider`. A rule whose
  `rawSql` reads it is skipped for a user with no zone, as day cadence is.
- `$deviceId` — the device the app's `userDeviceProvider` (a
  `createRulesEngine` option) names for the user, asked once per user per
  pass. When there is no provider, or it returns undefined, an empty id, or
  throws, `$deviceId` is bound as **NULL** and the rule still runs. Write
  the filter as
  `(CAST($deviceId AS VARCHAR) IS NULL OR device_id = CAST($deviceId AS VARCHAR))`
  to read every device in that case, or add
  `AND CAST($deviceId AS VARCHAR) IS NOT NULL` to stay silent instead. The
  value bound is in the violation's `evidence.deviceId`.
- `rawSqlSettings: { name: { key, defaultValue, type? } }` binds `$name` to
  the user's stored value of `key`, `defaultValue` when unset or unusable.
  `type` is `'number'` or `'string'`; when omitted it is
  `typeof defaultValue`, so `{ key, defaultValue: 60 }` is a number setting
  exactly as in 0.63. Given, it must agree with the default.
  - `number`: a stored number or numeric string is bound, read like a
    `user_setting` threshold; the key must be rule-readable.
  - `string`: a stored non-empty string is bound (surrounding JSON quotes
    removed); a stored number, boolean, object or empty string binds the
    default. The key must be a registered string setting (it need not be a
    threshold: a mode or sensitivity name is fine). Map names to values in
    the SQL, with an `ELSE` for a name the rule does not know.

  Names `userId`, `brand`, `familyId`, `tz` and `deviceId` are reserved.
  The values used are in the violation's `evidence.rawSqlSettingsUsed`.
  Every value is a bound parameter: a stored string never becomes SQL text.

The body must project `observed_value` and `threshold_value`, one row per
violation (the first row is used). CAST every bound value where it is used
(`CAST($tz AS VARCHAR)`, `CAST($floor AS DOUBLE)`, `CAST($n AS BIGINT)`,
`CAST($mode AS VARCHAR)`):
on device a parameter's type resolves from SQL context at prepare time.
For local time of a naive-UTC column, use
`timezone(CAST($tz AS VARCHAR), timezone('UTC', ts))`.

```ts
// Any local hour of the last day that averaged above the user's level.
{
  id: 'acme.hour-above-level', name: 'Hour above level', metric: 'gauge_level',
  window: '24h', compare: 'greater_than', severity: 'info',
  target: { type: 'absolute', value: 0 }, // unused by rawSql
  rawSqlSettings: { level: { key: 'user:gaugeLevel', defaultValue: 60 } },
  rawSql: `
    WITH hourly AS (
      SELECT date_trunc('hour', timezone(CAST($tz AS VARCHAR), timezone('UTC', ts))) AS h,
             AVG(level) AS v
      FROM v_gauge
      WHERE user_id = $userId AND brand = $brand AND family_id = $familyId
        AND ts > NOW() - INTERVAL 1 DAY
      GROUP BY h)
    SELECT MAX(v) AS observed_value, CAST($level AS DOUBLE) AS threshold_value
    FROM hourly HAVING MAX(v) > CAST($level AS DOUBLE)`,
}

// The same on one device, with a named width the user picks.
{
  id: 'acme.day-above-band', name: 'Day above band', metric: 'gauge_level',
  window: '24h', compare: 'greater_than', severity: 'info',
  target: { type: 'absolute', value: 0 },
  rawSqlSettings: {
    level: { key: 'user:gaugeLevel', defaultValue: 60 },
    width: { key: 'user:gaugeWidth', defaultValue: 'normal' }, // string
  },
  rawSql: `
    WITH f AS (
      SELECT CASE CAST($width AS VARCHAR)
               WHEN 'wide' THEN 1.5 WHEN 'narrow' THEN 0.75 ELSE 1.0 END AS k)
    SELECT AVG(level) AS observed_value,
           CAST($level AS DOUBLE) * (SELECT k FROM f) AS threshold_value
    FROM v_gauge
    WHERE user_id = $userId AND brand = $brand AND family_id = $familyId
      AND (CAST($deviceId AS VARCHAR) IS NULL OR device_id = CAST($deviceId AS VARCHAR))
      AND ts > NOW() - INTERVAL 1 DAY
    HAVING AVG(level) > CAST($level AS DOUBLE) * (SELECT k FROM f)`,
}
```

Compiled SQL is memoized by `(ruleId, registry revision)`; register / enable
/ disable bump the revision.

## Throttle

Two KV keys per (ruleId, userId): the last fire time, and a daily count. A
rule is throttled while `now - last < minGapMinutes` or the day's count has
reached `maxPerDay`. Time comes from `config.clock`.

## Catalogs

```toml
[[rule]]
id = "acme.gusty-day"
name = "Gusty day"
metric = "wind_kph"
window = "24h"
aggregation = "max"
compare = "greater_than"
severity = "warn"

[rule.target]
type = "absolute"
value = 60

[rule.throttle]
minGapMinutes = 240
maxPerDay = 2
```

`parseCatalog(toml, { name })` runs every entry through `RuleSchema`; a TOML
syntax error is rethrown as `RuleValidationError` naming the catalog. Default
catalogs belong to the domain pack, not to this package.

## Hooks

React is an optional peer.

```ts
const { violations, clear } = useRuleViolations(engine, { limit: 50 })
const { rules, enable, disable } = useRuleRegistry(engine)
```
