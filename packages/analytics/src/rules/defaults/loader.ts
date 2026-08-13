/**
 * TOML catalog parser for brand default rules.
 *
 * A catalog is a TOML document with one or more `[[rule]]` array-of-tables
 * entries; each entry is passed through `RuleSchema.safeParse` so bad
 * catalogs fail at package load time with a precise message.
 *
 * The parser only wraps `@iarna/toml` — a TOML syntax error is rethrown as
 * a `RuleValidationError` with a catalog-aware prefix so consumers can
 * locate the offending brand file.
 */

import type { Rule } from '../schema'
// Direct import of parse-string avoids the parse.js -> parse-stream.js ->
// require('stream') chain that breaks Metro (React Native has no Node stdlib).
import parseString from '@iarna/toml/parse-string.js'
import { RuleSchema, RuleValidationError } from '../schema'

interface CatalogDoc {
  rule?: unknown[]
}

export interface ParseCatalogOptions {
  /** Human-readable catalog name for error messages (e.g. `'ziva'`). */
  name?: string
}

export function parseCatalog(
  toml: string,
  options?: ParseCatalogOptions,
): Rule[] {
  const label = options?.name ?? 'catalog'
  let doc: CatalogDoc
  try {
    doc = parseString(toml) as CatalogDoc
  }
  catch (err) {
    throw new RuleValidationError(
      `${label}: TOML parse error — ${(err as Error).message}`,
    )
  }

  const raw = doc.rule
  if (!Array.isArray(raw)) {
    throw new RuleValidationError(
      `${label}: missing [[rule]] entries`,
    )
  }

  const rules: Rule[] = []
  for (let i = 0; i < raw.length; i++) {
    const parsed = RuleSchema.safeParse(raw[i])
    if (!parsed.success) {
      throw new RuleValidationError(
        `${label}: rule ${i} invalid — ${parsed.error.message}`,
      )
    }
    rules.push(parsed.data)
  }
  return rules
}
