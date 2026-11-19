/**
 * The platform's own tables — domain-free bookkeeping every app gets:
 * insights, sync cursors, the tool-call audit log, and per-user metric
 * baselines. DDL verbatim from the package's former `SCHEMAS`.
 *
 * A leaf module (no runtime imports) so the registry, the schema helpers and
 * the platform pack can all read it without an import cycle.
 */

import type { PackTable } from './packs'

export const PLATFORM_TABLE_NAMES = [
  'insight',
  'sync_watermark',
  'tool_call_audit',
  'user_baseline',
] as const

export type PlatformTableName = (typeof PLATFORM_TABLE_NAMES)[number]

export const PLATFORM_SCHEMAS: Readonly<Record<PlatformTableName, string>> = Object.freeze({
  insight: `CREATE TABLE insight (
  insight_id VARCHAR PRIMARY KEY,
  ts TIMESTAMP NOT NULL,
  brand VARCHAR NOT NULL,
  family_id VARCHAR NOT NULL,
  user_id VARCHAR NOT NULL,
  rule_id VARCHAR,
  metric VARCHAR NOT NULL,
  kind VARCHAR NOT NULL,
  severity VARCHAR NOT NULL,
  title VARCHAR NOT NULL,
  body TEXT,
  evidence VARCHAR,
  acknowledged_at TIMESTAMP,
  dismissed_at TIMESTAMP
) PARTITIONED BY (day(ts));`,

  sync_watermark: `CREATE TABLE sync_watermark (
  brand VARCHAR NOT NULL,
  family_id VARCHAR NOT NULL,
  table_name VARCHAR NOT NULL,
  kind VARCHAR NOT NULL,
  cursor_ts TIMESTAMP NOT NULL,
  updated_at TIMESTAMP NOT NULL,
  PRIMARY KEY (brand, family_id, table_name, kind)
);`,

  tool_call_audit: `CREATE TABLE tool_call_audit (
  ts TIMESTAMP NOT NULL,
  brand VARCHAR NOT NULL,
  family_id VARCHAR NOT NULL,
  requester_user_id VARCHAR NOT NULL,
  tool_name VARCHAR NOT NULL,
  args VARCHAR NOT NULL,
  result_bytes INTEGER,
  result_row_count INTEGER,
  latency_ms INTEGER,
  outcome VARCHAR NOT NULL,
  error_message VARCHAR
) PARTITIONED BY (day(ts));`,

  // Sprint 5 §7 — shared baseline source of truth for rules, tools, and
  // screens. Quantiles are computed DAY-FIRST (principle 27): readings
  // collapse to one value per local day, then quantiles run across days.
  // `sample_count` therefore counts DAYS, not readings — a row is only
  // written at >= 20 days (BASELINE_MIN_DAYS).
  //
  // Not partitioned: the table holds at most
  // (metrics x windows) = 21 rows per user, and the composite PK is the
  // only access path any consumer uses.
  user_baseline: `CREATE TABLE user_baseline (
  brand VARCHAR NOT NULL,
  family_id VARCHAR NOT NULL,
  user_id VARCHAR NOT NULL,
  metric VARCHAR NOT NULL,
  window_days SMALLINT NOT NULL,
  p05 DOUBLE,
  p10 DOUBLE,
  p50 DOUBLE,
  p90 DOUBLE,
  p95 DOUBLE,
  mean DOUBLE,
  stddev DOUBLE,
  sample_count INTEGER,
  computed_at TIMESTAMP NOT NULL,
  PRIMARY KEY (brand, family_id, user_id, metric, window_days)
);`,
})

export const PLATFORM_TABLES: Readonly<Record<PlatformTableName, PackTable>> = Object.freeze({
  insight: {
    ddl: PLATFORM_SCHEMAS.insight,
    timeColumn: 'ts',
    syncable: true,
    retention: { tsColumn: 'ts', kind: 'insight' },
  },
  // Per-device bookkeeping, never pushed. NOT local-only: the retention
  // integration cases sweep against the real attached Iceberg catalog and
  // need the table present there; an empty remote copy is harmless.
  sync_watermark: {
    ddl: PLATFORM_SCHEMAS.sync_watermark,
    timeColumn: 'updated_at',
    syncable: false,
    retention: null,
  },
  // An append-only audit log keyed by requester, so the sweep is scoped by
  // brand and family only. Two identical calls at the same instant are two
  // real events, so no identity key.
  tool_call_audit: {
    ddl: PLATFORM_SCHEMAS.tool_call_audit,
    timeColumn: 'ts',
    syncable: false,
    retention: { tsColumn: 'ts', kind: 'audit', tenantColumns: ['brand', 'family_id'] },
  },
  // Derived, local-only, and UPSERTed in place — never pushed, and its
  // `computed_at` is a recompute stamp rather than a sync cursor. Pushing it
  // would invite two devices in one family to race on the same composite PK.
  user_baseline: {
    ddl: PLATFORM_SCHEMAS.user_baseline,
    timeColumn: 'computed_at',
    syncable: false,
    retention: null,
    localOnly: true,
  },
})
