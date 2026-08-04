# Upgrading

## 0.6.0 → 0.7.0 (Sprint 5 coordinated release)

This is a **coordinated release**. Upgrade all four together — the packages
share contracts that changed in lockstep:

| Package | From | To |
|---|---|---|
| `@mongrov/analytics` | 0.6.0 | **0.7.0** |
| `@mongrov/data-access` | 0.1.0 | **0.2.0** |
| `@mongrov/types` | 0.4.0 | **0.5.0** |
| `@mongrov/device` | 0.1.1 | **0.2.0** |

> The Sprint 5 spec named these 0.2.0 / 0.2.0 / 0.4.0 / 0.2.0. Those targets
> were unreachable: analytics had already shipped 0.2.0→0.6.0 across five
> post-Sprint-4 releases, and types had reached 0.4.0 without ever landing
> the Sprint 3 §18 content. Versions are next-minor-from-actual.

---

## 1. Breaking: mapped sleep row shapes

**Who is affected:** anyone who consumes `MappedBatch` directly, supplies
`columnOrder` for sleep tables, or has snapshot tests over mapper output.

The sleep mapper had drifted from the DDL it writes to and was emitting rows
the `sleep_session` table could not accept. If you were flushing sleep data,
it was failing (or writing NULLs into NOT NULL columns) — this release fixes
that, and the row types changed as a result.

```diff
 interface SleepSessionRow {
   session_id: string
-  ts: Date              // no such column; DDL partitions on day(ts_start)
-  start_ts: Date
-  end_ts: Date
+  ts_start: Date
+  ts_end: Date
+  total_minutes: number        // NOT NULL — was never produced
+  deep_minutes: number | null
+  rem_minutes: number | null
+  light_minutes: number | null
+  awake_minutes: number | null
+  avg_confidence: number | null
   night_of: Date
 }

 interface SleepStageRow {
-  stage: string         // firmware block_type leaked into an INTEGER column
+  stage: number         // 1=awake, 2=light, 3=deep, 5=rem
-  confidence: number
+  confidence: number | null
 }

 interface SleepRawRow {
-  payload: FirmwareSleepRow    // no such column
+  ts_session_start: Date
+  quality: number              // NOT NULL; derived from confidence when
+  unit_length: number | null   // firmware omits it
 }
```

Two smaller removals in the same pass — both were keys with no column:

```diff
-interface ActivityBucketRow { steps: number; … }   // steps live on `activity`
-interface DeviceConfigRow   { ts: Date; … }        // axis is valid_from/valid_to
```

**Migrating `columnOrder`:** if you hand-wrote sleep entries, regenerate them
from the DDL. Column names now match exactly, so
`columnOrder[table].map(c => row[c])` works without translation.

**Behaviour changes worth knowing:**

- Session boundaries come from the firmware's own `start`/`end` fields, not
  min/max of block instants. Deriving from blocks under-reported any session
  whose first or last minutes went unclassified.
- `primary` blocks produce **no** `sleep_stage` row. The DDL enum has no code
  for them and they read as the session envelope rather than a stage. All
  blocks are still preserved in `sleep_raw`. *Open question with the firmware
  team — see `analytics-sync/tasks.md` T-06.*

A new contract test (`mapper/__tests__/ddl-contract.test.ts`) parses
`core/schemas.ts` and asserts every mapped row's keys are real columns and
every NOT NULL column is populated. If you extend the mapper, it will tell
you when you drift.

---

## 2. Breaking: `AnalyticsEngine` gained two methods

**Who is affected:** anyone implementing `AnalyticsEngine` — test fakes,
custom adapters.

```diff
 interface AnalyticsEngine {
   …
+  getFamilyMembers(): Promise<string[]>
+  dismissInsight(args: { insightId: string; userId: string }): Promise<void>
 }
```

`getFamilyMembers()` closes a principle-39 gap: the rules evaluator and the
AI-tools authorize hook each held their own wire to family membership. Now
both go through the engine, which delegates to the `familyMembersProvider`
you configured at `createAnalytics` and caches for 60s.

Minimal fake:

```ts
const engine: AnalyticsEngine = {
  …,
  async getFamilyMembers() { return ['alice', 'bob'] },
  async dismissInsight() {},
}
```

---

## 3. Breaking: authorize hooks no longer fall back to SQL

`familyScopeAuthorize` / `orgScopeAuthorize` previously fell back to
`SELECT 1 FROM family_member …` when no provider was passed. **No DDL in this
package ever created that table**, so the fallback could only throw and fail
closed — silently denying every cross-member query on any install that did
not pass a provider explicitly.

```diff
-familyScopeAuthorize(analytics)                       // used a phantom table
+familyScopeAuthorize(analytics)                       // uses engine roster
 familyScopeAuthorize(analytics, { familyMembersProvider })  // still wins
```

If you relied on the SQL path, wire `familyMembersProvider` at
`createAnalytics` instead. Membership lives in the RxDB Family doc, not
DuckDB.

---

## 4. Breaking: generated SQL reads `v_{table}` views

Rule SQL and tool SQL now target the union views instead of raw catalogs.
This is what lets a rule fire on data flushed locally but not yet pushed to
R2 — i.e. this morning's sync.

**Consequence:** the views must exist. They are created on `attach()` and
dropped on `detach()`, so anything executing rule or tool SQL against a
non-attached engine now fails where it previously read stale remote rows.

View bodies inline `brand` and `family_id`, because DuckDB views cannot bind
parameters. That makes per-attach recreation a **correctness** requirement,
not housekeeping — a brand switch reusing old views would serve the previous
tenant's rows. Handled automatically; do not cache view DDL yourself.

`insight` is deliberately *not* viewed — it is local-authoritative.

---

## 5. Behaviour change: rules evaluate on `batch:complete`

Rules previously evaluated once per table, on each `{table}:insert`. They now
evaluate once per batch. **Default is the new behaviour.**

This fixes a real race: a `context: 'asleep'` rule JOINs `v_sleep_session`,
and firing it the moment `spo2` flushed let it evaluate against a night whose
sleep rows were still buffered.

```ts
createSyncManager({
  …,
  strictBatchOrdering: false,  // opt out — restores per-table triggering
})
```

Only opt out if you need lower evaluation latency **and** ship no
context-JOIN or `consecutive` rules.

Per-table `{table}:insert` events still fire — they drive cache
invalidation, which wants to refresh as early as possible. `batch:complete`
is additional, not a replacement.

---

## 6. New config: `userTimezoneProvider`

Day-first baselines bucket by **local** day, so they need each user's IANA
zone. `User.timezone` lives in auth/RxDB where this package cannot reach it.

```ts
createSyncManager({
  …,
  userTimezoneProvider: async (userId) => (await getUser(userId))?.timezone,
})
```

Unwired, it falls back to the device zone — wrong for a travelling user or
one whose profile zone differs from their device. Baselines still compute;
they just bucket by the wrong midnight.

---

## 7. Rules schema additions

Additive — existing rules keep parsing. New fields:

```toml
context = "asleep"      # 'any' (default) | 'asleep' | 'resting'
consecutive = 3         # require N adjacent breaching samples

[rule.target]
type = "user_setting"   # threshold read from KVStore at eval time
key = "user:spo2SafeLevel"
defaultValue = 90
```

`user_setting` is what makes a user-configurable threshold work without
per-user rule rows: the compiled SQL is threshold-agnostic, and the evaluator
binds `analytics:{userId}:{key}` at eval time, falling back to `defaultValue`.

Two constraints the validator now enforces:

- `consecutive` is **rejected with baseline targets**. Baselines resolve
  per-window, not per-sample; there is no correct query shape, so it throws
  rather than emitting something subtly wrong.
- `consecutive × sampling_minutes` must fit the window, or the rule could
  never fire.

**Ziva catalog rule ids changed.** Throttle state is keyed by rule id, so
existing throttle counters for the renamed rules are orphaned (they expire
naturally):

| Was | Now |
|---|---|
| `ziva.sleep-deprivation-3d` | `ziva.sleep-deprivation-3` |
| `ziva.stress-elevated` | `ziva.stress-elevated-day` |
| `ziva.activity-low-24h` | `ziva.low-activity-week` |

`ziva.hrv-drop-30` and `ziva.stress-elevated-day` also switched from
`absolute` to `baseline_percent` / `baseline_stddev` targets — a fixed HRV
threshold is meaningless across users.

Also note `registry.register()` is **async**. An un-awaited call silently
no-ops:

```diff
-rules.register(zivaDefaults)
+await rules.register(zivaDefaults)
```

---

## 8. Copy guardrails — contract for tool authors

Every tool formatter must call `assertNoBanTerms(text, formatterName)` on its
return path. Tool output lands in an LLM's context, and the model repeats
whatever register it finds there.

```ts
import { assertNoBanTerms } from '@mongrov/analytics/tools'

function finalize(text: string, rowCount: number): ToolResult {
  assertNoBanTerms(text, 'myTool')
  return { text, rowCount, bytes: formatBytes(text) }
}
```

It throws `FormatterCopyError` on any banned medical term. Matching is
leading-boundary, so `desaturation` also catches `desaturations` — over-
blocking is the right bias here. `applyPreferredLanguage(text)` rewrites the
common phrasings, but it is a convenience, not a substitute: the guard still
runs afterwards.

This applies to text you did not author. An insight row titled *"Nocturnal
desaturation detected"* interpolated into `getInsights` output fails the tool
call — which is the point.

---

## 9. `@mongrov/data-access` 0.2.0

`RequestContext` shape:

```diff
 interface RequestContext {
-  requesterUserId: string
+  userId: string       // canonical — queries bind it as $userId
   brand: string
   familyId: string
+  timezone: string     // bound as $tz by every day-grouped query
   now: () => Date
 }
```

Both are required. Update your `DataAccessProvider` context factory.

The remaining 0.2.0 items (`asyncFetch`, `fetching` hook state,
JOIN-invalidation validator, `transform` field, `MutationContext.analytics`)
were already implemented before this release; 0.2.0 records the version.

---

## 10. `@mongrov/types` 0.5.0

Additive. Lands the Sprint 3 §18 layer every Sprint 4 feature was written
against but which never shipped: `Brand`, `Family`, `User`,
`AnalyticsDevice`, `SensorSink`, `FirmwareExport`, `MapperContext`,
`EventBus`, and the seven missing `AnalyticsQuerySchemas`.

**`AnalyticsDevice`, not `Device`.** `types/device.ts` already exports a
`Device` describing the BLE transport's view (adapterId, connection state,
RSSI). Both are legitimate and neither is a superset — one is the durable
tenancy record sensor rows key against, the other is the live connection
handle. The existing `Device` is unchanged.

`DEVICE_EVENT_TYPES` and its payload schemas now live here canonically
(`@mongrov/types/device-events`); `@mongrov/analytics` re-exports them. This
is what lets `@mongrov/device` emit events the analytics engine will store
without depending on the engine.

---

## 11. Migrations

One new migration runs automatically on attach:

| Version | What |
|---|---|
| v4 | `user_baseline` table (local catalog only) |

**Numbering note.** The Sprint 5 spec called this "migration v3" and
specified a "v4" adding `insight.dismissed_at`. Versions 2 and 3 were already
spent (`device_battery`, `insight` v2 rebuild), and `dismissed_at` already
ships in the baseline DDL with migration v3 backfilling it — so the ALTER
would have been a no-op against an existing column.

`user_baseline` and `sync_watermark` are **local-only** — never created in
the attached R2 zone. Baselines are derived data, cheap to recompute, and
pushing them would invite two devices in one family to race on the same
composite PK.

---

## 12. Known gaps in this release

Documented so you do not go looking:

- **`device_config` still uses `data_type SMALLINT`.** Sprint 5 §2's change
  to `metric VARCHAR` is blocked: the spec's firmware codes (1/2/4) do not
  match the real JStyle codes (`HR:0, SLEEP:1, SPO2:3, HRV:8, ACTIVITY:9,
  TEMPERATURE:14`), and SpO₂/temperature are separate schedules — so the
  "fan-out `data_type=2` into two rows" the task describes may not correspond
  to real hardware behaviour. Unresolved with the firmware team.
- **`@mongrov/device` sync events are emitter-only.** `createSyncEventEmitter`
  and the `DeviceEventSink` port ship and are usable stand-alone, but the sync
  machine that would call them is D5 work and does not exist yet.
- **`@mongrov/types` subpaths emit ESM with no `require` condition.**
  Type-only imports are erased so nothing hit this before; a cross-package
  *value* import from `@mongrov/types/device-events` or `/analytics-queries`
  needs a resolver mapping under CJS (see `packages/device/jest.config.js`).
  Dual emit is the proper fix.
- **`transform` is declared but not resolved** by the data-access dispatcher.
  Queries declaring it will not produce derived output fields yet.
