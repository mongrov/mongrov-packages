# Changelog

## [0.62.2] - 2026-11-22

A lint rule for tool input schemas in `@mongrov/analytics/tools`.

### Fixed

- **`lintToolInputSchema` errors on an anchored string `pattern`**
  (rule `pattern-anchored`, #116): one that starts with `^` or ends with an
  unescaped `$` (`\$` is a literal dollar, not an anchor). The bridge's
  schema parser accepts it, but on-device structured generation with Apple
  Foundation Models then fails every request before any tool runs. The
  unanchored pattern works (the on-device guide constrains the whole value
  anyway). Drop the anchors and check the exact form with a refine or in
  the tool. `defineTool` throws on it in dev and test, like every lint
  error.

## [0.62.1] - 2026-11-22

A fix to the per-answer cache of `@mongrov/analytics/tools`. One additive
export.

### Fixed

- **Identical calls in one answer get one cached repeat.** The first repeat
  of the same tool with the same validated arguments is still answered from
  the answer's cache and not counted. The second and later repeats are
  refused without running or rendering: the model gets exactly
  `You already have this result above; answer from it.` (the same line on
  structured and compatibility tools), the envelope is `error` with code
  `call_limit`, and the audit row is `outcome = 'call_limit'`,
  `error_code = 'call_limit'`, `cached = true`, with `turn_id`, `call_index`
  and `error_message = 'identical repeat <n>'`. A refused repeat counts
  toward `callLimit.perTurn` and toward `TurnSummary.refused`. Before, every
  repeat returned the full cached result uncounted, so a model could loop on
  one call and fill a small context with copies of it.

### Added

- `DUPLICATE_CALL_GUIDANCE`, the refusal line above.

## [0.62.0] - 2026-11-21

Typed tool results for `@mongrov/analytics/tools`. Additive for tools that
return `ToolResult` text: their output, budget and refusals are unchanged
byte for byte. One type rename (see Breaking).

### Breaking

- The audit union `ToolOutcome` is renamed **`AuditOutcome`**; the name
  `ToolOutcome` now belongs to the result envelope below, so no alias is
  possible. `ToolCallResult` (the same union) is still exported.
- `AuditOutcome` gains `invalid_args` (refused arguments were recorded as
  `error` with an `invalid_args:` message prefix; now their own outcome, the
  message without the prefix) and `call_limit`.

### Added

- **`defineTool`** — a tool with input and output Zod schemas, an impl that
  returns a **`ToolOutcome<D>`** envelope (`status` ok / empty / insufficient
  / error, `data`, `window { from, to, timezone, partialToday, label? }`,
  `asOf`, `error { code, message, retryable }`, `truncated`, `guidance`),
  and optional `render`, `budget`, `annotations`, `title`. `outcome.ok /
  empty / insufficient / invalid` build envelopes. `PackTool` widens
  additively, so a definition goes in `pack.tools` or to `handle.add`.
- **The chain** for structured tools: input check → answer cap → rate limit
  → authorize → execute → output check → copy guard over every string →
  render → budget → audit → `onResult` → one string to the model.
  - Output check: the envelope rules and `outputSchema`. A failure is
    `error/output_invalid` (the audit lists paths, never values); under a
    test runner it throws `ToolOutputError` (`outputValidation` overrides).
- **Renderers**: `renderers.lines` (default; `key: value` lines),
  `renderers.json`, `renderers.sentence(template)`; chosen by
  `config.render.byTool` → the definition → `config.render.default`.
- **Character budget** for structured results: `outputBudget.maxChars`
  (default 1,200 per result) and `outputBudget.turnChars` (default 3,600 per
  answer). Whole items of declared lists (`budget.listPaths`) go first,
  oldest first, then a line cut. `truncated` is set by the framework only.
- **Answers**: `handle.beginTurn()` returns `{ id, end() }`. Within it the
  call cap (`callLimit.perTurn`, default 4) refuses later calls with
  `call_limit`, and a repeat of the same tool with the same arguments is
  answered from the answer's cache, audited `cached`, and not counted.
- **`onResult`** (`config.onResult`, `handle.onResult(listener)`): one
  `ToolResultEvent` per call, refusals included, after its audit record.
- **`handle.add(def)`**: wraps a host tool and lists it in `handle.tools`.
- **Audit** (platform migration 3): `tool_call_audit` gains nullable
  `result_status`, `error_code`, `result_digest` (FNV-1a-64 of the text the
  model got; no result content is stored), `render_chars`,
  `truncated_items`, `turn_id`, `call_index`, `cached`. Refused calls
  (`call_limit`, `invalid_args`, `rate_limited`, `authorized_reject`) each
  write a row.
- **MCP**: structured tools list `outputSchema` (the envelope) and return
  `structuredContent`, a JSON text copy (or the model's string with
  `text: 'render'`), and `isError` from the status; every tool lists
  `annotations` (read-only, idempotent, closed-world by default) and `title`.
  Tools added with `handle.add` are listed.
- **`lintToolInputSchema`** and **`parseLikeAppleBridge`**: the on-device
  JSON Schema subset, mirroring the `@react-native-ai/apple` 0.12 schema
  parser rule for rule. `defineTool` throws on a lint error in dev and test.
- Exports: `toolOutcomeJsonSchema`, `toOutputJsonSchema`, `fnv1a64`,
  `describeAge`, `CALL_LIMIT_GUIDANCE`, `UNREADABLE_GUIDANCE`,
  `DEFAULT_CALL_LIMIT`, `DEFAULT_MAX_CHARS`, `DEFAULT_TURN_CHARS`.

### Changed

- `ToolResult` is superseded for new tools by `defineTool` and the envelope.
  It keeps working (not tagged `@deprecated`, so a consumer's deprecation
  lint does not fail) and is removed only after every pack has moved.
- `getInsights` is unchanged (it stays on the `ToolResult` path).

## [0.61.1] - 2026-11-21

Fixes to the AI tool framework (`@mongrov/analytics/tools`). Tool names and
the shape of their text are unchanged; two additive exports.

### Fixed

- Tool arguments are validated. `makeTool` parses every call with the tool's
  Zod schema before anything else runs, so `.default()` values apply and every
  bound holds, whatever the caller checked: the AI SDK's `jsonSchema()` has no
  validator, an on-device bridge may keep only one numeric bound, and MCP
  passed arguments straight through. A refused call returns
  `Invalid arguments: days must be a whole number from 1 to 90 (got 0).` and is
  audited as `error` with an `invalid_args:` message.
- The JSON Schema given to the model is the input view: a field with a
  default is optional (zod 4 listed it in `required`) and carries its default.
- Every registered `copyGuard` runs over every tool's text in the wrapper,
  not only where an impl called it.
- The output budget drops dated rows oldest first and always keeps the header
  and summary lines, with one `[truncated: N earlier rows left out]` line in
  their place. It used to cut from the end, losing the newest rows and the
  summary first. Text without dated rows is cut as before.
- MCP: `isError: true` for refused arguments, rate-limited, unauthorized,
  context-less and failed calls; the text is unchanged.
- `getInsights` prints insight times in the user's zone (it printed naive UTC
  with no marker), and its description lists exactly what it takes and returns.

### Added

- `handle.wrap(name, def)` on `createAnalyticsTools`' handle: runs a host's
  own tool through the same chain as pack tools (validation, the shared rate
  limiter, authorization, copy guards, budget, the same audit writer).
- `trimOldestRows(text, fits, marker)`: the budget's row-dropping rule, for a
  host's own, smaller cap.

## [0.61.0] - 2026-11-20

Additive: no change to existing exports or behaviour.

### Added

- `@mongrov/analytics/testing`: the engine's pure modules — pack registry
  (with `resetPacks` for test isolation), DDL and schema helpers, platform
  tables, metric and relation lookups, bounded reads, errors, and from
  `/sync` the baseline runner, ingest drop accounting, `mergeFlushResults`
  and `logError` — for an app's test double of this package. Same names and
  module instances as the root and `/sync` exports; no native module, no
  React, no side effect on import. Replaces deep imports of `dist/` files.
- `userSettingKey(userId, key)` (root and `/rules`): the `KVStore` key the
  rules engine reads a `user_setting` threshold or `phase_band` scale from
  (`analytics:<userId>:<key>`), so an app or pack writing those settings no
  longer restates the prefix. The rules engine reads through it.

### Changed

- README: the quick start compiles against the current API (`tokenVendor`
  returns `scopeClaims`; attach is on the engine, `useAnalytics()` reports
  state); links to files that do not ship point at the repository.
- `UPGRADING.md` no longer links to pre-0.60 notes; those ship in the
  earlier versions' own `UPGRADING.md`.
- Comments no longer name a pack's tables.

## [0.60.1] - 2026-11-19

### Fixed

- The platform pack's starting migration version is persisted even when it
  is 0, so an interrupted first attach retries the platform migrations instead of
  skipping them.
- Post-flush jobs and after-push hooks are isolated per job: one that throws
  is logged and skipped, and the rest of the flush (or sync cycle) still runs.
- Name collisions between registered packs — ingest adapters, rule contexts
  and tools — throw `AnalyticsError('invalid_config')` at registration, like
  table collisions. Before, the first adapter or context won and the last
  tool won, silently.
- The internal default-pack registration (used by the package's own test
  suites; not exported) validates its packs as `definePack` does.

### Changed

- Docs, comments and type docs are brand- and domain-free.
- Test fakes (`__fakes__`) and test directories are no longer compiled into
  `dist/`.
- `prepublishOnly` runs the domain-term guard over the files `npm pack` publishes.
- `UPGRADING.md` keeps only the 0.60 notes; earlier history moved to the
  repository (`docs/history/`).

## [0.60.0] - 2026-11-19

The engine is domain-free: a domain's tables, views, ingest adapters,
post-flush jobs, baselines, metrics, rules and tools arrive as a pack
(`definePack`, `registerPack`, `createAnalytics({ packs })`). Breaking for
imports; see [UPGRADING.md](./UPGRADING.md).
