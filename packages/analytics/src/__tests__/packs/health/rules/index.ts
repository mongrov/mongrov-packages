/**
 * Brand default rule catalogs.
 *
 * Each brand exports a fully-validated `Rule[]` parsed from its inlined
 * TOML source at package-load time; a malformed default therefore fails
 * fast rather than at first evaluate.
 *
 * Engine suites outside this directory must not name a brand (the
 * domain-term guard checks brands in every test file), so they read the
 * catalogs through `primaryDefaults` / `secondaryDefaults`: the same rules,
 * re-branded to a placeholder brand (id prefix and `brand`).
 */

import type { Rule } from '../../../../rules/schema'
import { luminxDefaults } from './luminx'
import { zivaDefaults } from './ziva'

export { parseCatalog, type ParseCatalogOptions } from '../../../../rules/defaults/loader'
export { luminxDefaults, zivaDefaults }

/** `rules` with `brand` as their brand and id prefix (`<brand>.<name>`). */
export function rebrand(rules: readonly Rule[], brand: string): Rule[] {
  return rules.map(r => ({ ...r, brand, id: r.id.replace(/^[^.]+\./, `${brand}.`) }))
}

/** The main catalog (every metric's defaults), as brand `acme`. */
export const primaryDefaults: Rule[] = rebrand(zivaDefaults, 'acme')
/** A second, device-only catalog (battery rules), as brand `globex`. */
export const secondaryDefaults: Rule[] = rebrand(luminxDefaults, 'globex')
