/**
 * Brand default rule catalogs.
 *
 * Each brand exports a fully-validated `Rule[]` parsed from its inlined
 * TOML source at package-load time; a malformed default therefore fails
 * fast rather than at first evaluate.
 */

export { zivaDefaults } from './ziva'
export { luminxDefaults } from './luminx'
export { vivaDefaults } from './viva'
export { yogaringDefaults } from './yogaring'
export { parseCatalog, type ParseCatalogOptions } from './loader'
