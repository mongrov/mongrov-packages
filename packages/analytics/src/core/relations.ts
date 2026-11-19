/**
 * What a claim reads for a table. A pack's quality views may stand in for
 * the plain union view (`v_<table>`): rules, baselines and tools then read
 * the clean relation, and bounded reads use its `_between` macros.
 */

import { qualityProviders } from './packs'

function providerFor(table: string) {
  return qualityProviders().find(p => p.relations?.has(table))?.relations
}

/** Whether a pack declares quality relations for `table`. */
export function hasQualityRelations(table: string): boolean {
  return providerFor(table) !== undefined
}

/** The relation a claim reads: the clean view when a pack has one, else `v_<table>`. */
export function readRelation(table: string): string {
  return providerFor(table)?.clean(table) ?? `v_${table}`
}

/** The clean relation (claims) for a table with quality relations. */
export function cleanRelation(table: string): string | undefined {
  return providerFor(table)?.clean(table)
}

/** The per-reading flags relation for a table with quality relations. */
export function qualityRelation(table: string): string | undefined {
  return providerFor(table)?.quality(table)
}
