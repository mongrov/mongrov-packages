/**
 * Pure DDL string helpers. A leaf module (no imports) so table declarations
 * can derive their local form at module load without an import cycle.
 */

const BARE_IDENT_RE = /^[A-Z_]\w*$/i
const PARTITIONED_BY_TAIL_RE = /\)\s*PARTITIONED BY[\s\S]*$/
// The DDL's closing paren, which is where the key clause is spliced in.
const DDL_TAIL_RE = /\n\);$/

/**
 * Quote a (possibly dotted) SQL qualifier for use in DDL/DML.
 *
 * Catalog names come from the database filename, so `my-app-analytics.duckdb`
 * yields the catalog `my-app-analytics` — and a bare hyphen is a syntax
 * error in an identifier position:
 *
 *   CREATE TABLE IF NOT EXISTS my-app-analytics.insight (...)
 *                                      ^ Parser Error: syntax error at or near "-"
 *
 * Each dot-separated part is quoted independently, because callers pass both
 * plain catalogs (`memory`) and qualified namespaces (`remote.analytics`).
 * Parts that are already quoted are left alone, and embedded double quotes
 * are doubled per SQL rules.
 */
export function quoteQualifier(qualifier: string): string {
  return qualifier
    .split('.')
    .map((part) => {
      if (part.startsWith('"') && part.endsWith('"'))
        return part
      // Leave plain identifiers bare. Quoting everything would work, but it
      // churns every emitted statement and makes the SQL harder to read for
      // the common `memory` / `main` case; only names that actually need it
      // get quoted.
      if (BARE_IDENT_RE.test(part))
        return part
      return `"${part.split('"').join('""')}"`
    })
    .join('.')
}

/**
 * Rewrite one base DDL to `CREATE TABLE IF NOT EXISTS <catalog>.<table>`.
 */
export function qualifyDdl(baseDdl: string, table: string, catalog: string): string {
  return baseDdl.replace(
    `CREATE TABLE ${table}`,
    `CREATE TABLE IF NOT EXISTS ${quoteQualifier(catalog)}.${table}`,
  )
}

/**
 * Strip the Iceberg-only `PARTITIONED BY (...)` clause from a DDL string.
 * Plain DuckDB (non-Iceberg) rejects the clause with a parser error; local
 * mode uses the returned form. Preserves the trailing `);` terminator.
 */
export function toLocalDdl(baseDdl: string): string {
  // The clause always terminates the DDL, and its column list contains
  // nested parens (`day(ts)`), so strip from the closing table paren to
  // end-of-string rather than trying to match the paren group.
  return baseDdl.replace(PARTITIONED_BY_TAIL_RE, ');')
}

/**
 * Inject an identity tuple as a `PRIMARY KEY` on a local DDL (principle 66).
 *
 * A no-op without columns, and for DDL that already declares a key — two
 * PRIMARY KEY clauses is a parser error rather than a merge.
 */
export function addIdentityKey(localDdl: string, cols: readonly string[] | undefined): string {
  if (!cols || localDdl.includes('PRIMARY KEY'))
    return localDdl
  return localDdl.replace(DDL_TAIL_RE, `,\n  PRIMARY KEY (${cols.join(', ')})\n);`)
}
