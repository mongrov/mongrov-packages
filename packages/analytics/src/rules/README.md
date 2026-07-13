# `@mongrov/analytics/rules`

Structured threshold rule engine over the analytics warehouse. Rules are
authored as Zod-typed objects (or TOML), compiled to parameterized
DuckDB SQL, evaluated on-batch + on-schedule, throttled via MMKV, and
delivered fire-and-forget through an emitter. The engine never mutates
warehouse state.

```ts
import {
  createRulesEngine,
  defaults,
} from '@mongrov/analytics/rules';

const engine = createRulesEngine({
  analytics,               // AnalyticsEngine (see @mongrov/analytics/core)
  storage,                 // KVStore (see @mongrov/db)
  familyMembersProvider,   // (ctx) => Promise<string[]>
  brand: 'ziva',
  familyId: currentUserId, // single-user family in v0.1.0
});

await engine.register(defaults.zivaDefaults);

engine.on('violation', (v) => notify(v));

// Wire into your sync pipeline
await engine.evaluateOnBatch({ affectedUserIds, affectedTables });
// …and/or the scheduler cadence
await engine.evaluateScheduled();
```

## Rule schema

```ts
{
  id: string,
  brand?: string,               // defaults to config.brand at match time
  name: string,
  description?: string,
  metric: MetricId,             // enum from METRIC_METADATA (exposed only)
  window: '1h' | '6h' | '24h' | '3d' | '7d' | '30d',
  aggregation: 'avg' | 'min' | 'max' | 'sum' | 'last' | 'count',
  compare: 'less_than' | 'greater_than' | 'equals' | 'not_equals' | 'between',
  target:
    | { type: 'absolute', value: number }
    | { type: 'baseline_percent', windowDays: number, percent: number }
    | { type: 'baseline_stddev',  windowDays: number, stddevs: number }
    | { type: 'range', min: number, max: number },
  severity: 'info' | 'warn' | 'critical',
  throttle: { minGapMinutes: number, maxPerDay: number },  // defaults 60 / 3
  rawSql?: string,              // escape hatch — allowlisted placeholders only
  rawSqlParams?: string[],
  exposureOverride?: boolean,   // required when rawSql touches collected_only cols
}
```

Rules are validated at `register()` time via `RuleSchema.parse` +
`validateRule` — a bad rule throws `RuleValidationError` before any SQL is
compiled.

## Sampling minimums

The validator refuses windows smaller than the metric's sampling cadence.
`per_session` metrics (sleep) require ≥ 3 days.

| Metric              | Cadence (min) | Minimum window |
|---------------------|---------------|----------------|
| hrv_ms              | 60            | 1h             |
| stress              | 60            | 1h             |
| hr_bpm              | 10            | 1h             |
| spo2                | 30            | 1h             |
| temp_c              | 30            | 1h             |
| activity_steps      | 1             | 1h             |
| calories            | 10            | 1h             |
| distance_km         | 10            | 1h             |
| sleep_total_minutes | per_session   | 3d             |
| sleep_score         | per_session   | 3d             |
| device_battery      | 240           | 6h             |

## Compilation

`compileRule(rule)` returns `{ sql, params, description }`. Guarantees:

- `$userId`, `$brand`, `$familyId` are always DuckDB-bound parameters —
  never string-concatenated.
- Rule thresholds (`$threshold_absolute`, `$range_min`, `$baselineDays`,
  `$pct`, `$stddevs`) are also bound parameters.
- Table + column identifiers come from `METRIC_METADATA[metric]`, are
  sanitized with `[^A-Za-z0-9_]/g → _`, then inlined as literals (DuckDB
  has no identifier-binding surface).
- `rawSql` is passed through with an allow-list check: every `$name`
  placeholder must be `{userId, brand, familyId}` or declared in
  `rawSqlParams`.

Property tests in `__tests__/compiler.property.test.ts` prove no
injection path exists across 1000 fast-check runs per `target.type`.

Compiled SQL is memoized by `(ruleId, registry.rev)`. Registry mutations
(register / enable / disable) bump `rev` and invalidate the cache
transparently.

## Throttle

Two KV keys per (ruleId, userId):

- `analytics:rules:throttle:{ruleId}:{userId}:last` — ISO string of the
  most recent fire.
- `analytics:rules:throttle:{ruleId}:{userId}:count:{yyyy-mm-dd}` —
  UTC daily count.

`isThrottled` blocks when `now - last < minGapMinutes` **or** the
current day's count exceeds `maxPerDay`. Stale daily-count keys are
purged on the next-day read.

Time is injected via `config.clock` (defaults to `() => new Date()`), so
tests can pin midnight-adjacent transitions deterministically.

## Brand defaults

Each brand ships a curated catalog under `defaults/`:

| Brand    | Export             | Count | Focus |
|----------|--------------------|-------|-------|
| Ziva     | `zivaDefaults`     | 4     | HRV drop, sleep deprivation, elevated stress, low activity |
| LuminX   | `luminxDefaults`   | 3     | Battery low, battery critical, disconnect |
| Viva     | `vivaDefaults`     | 2     | Battery low, disconnect |
| YogaRing | `yogaringDefaults` | 2     | Stress nudge, activity nudge |

Sidecar `.toml` files are the source of truth for authoring; the matching
`.ts` files inline the same content as a template literal so Metro/tsup
don't need a `.toml` loader. If you edit a sidecar, mirror the change into
the wrapper string (a `scripts/sync-toml.mjs` helper can be added if this
becomes friction).

## Authoring a custom rule

TOML — easiest for hand-editing:

```toml
[[rule]]
id = "myapp.custom.high-stress"
brand = "ziva"
name = "Sustained high stress"
description = "Average stress over the past 24h above 75."
metric = "stress"
window = "24h"
aggregation = "avg"
compare = "greater_than"
severity = "warn"

[rule.target]
type = "absolute"
value = 75

[rule.throttle]
minGapMinutes = 240
maxPerDay = 2
```

Load + register:

```ts
import { parseCatalog } from '@mongrov/analytics/rules';

const rules = parseCatalog(tomlString, { name: 'myapp' });
await engine.register(rules);
```

Object form is equivalent — `RuleSchema.parse(obj)` runs the same
validation path.

## Hooks

React is an optional peer.

```ts
const { violations, clear } = useRuleViolations(engine, { limit: 50 });
const { rules, enable, disable } = useRuleRegistry(engine);
```

Both are session-scoped: subscriptions tear down on unmount.

## Public surface

See `index.ts` — every module documented above is re-exported. Registry
and throttle stores are exposed for advanced composition; typical apps
should go through `createRulesEngine`.
