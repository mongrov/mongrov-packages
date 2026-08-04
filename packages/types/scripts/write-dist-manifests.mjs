/**
 * Stamp module-type markers into each dist tree.
 *
 * The package itself has no top-level `"type"` field, so Node infers CJS for
 * every `.js` it ships. That is right for `dist/cjs` and wrong for
 * `dist/esm` — without this marker Node parses the ESM build as CommonJS and
 * throws on the first `import` statement.
 *
 * Written at build time rather than committed so the two trees cannot drift
 * from what `tsc` actually emitted.
 */
import { mkdirSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const dist = join(dirname(fileURLToPath(import.meta.url)), '..', 'dist')

for (const [dir, type] of [['esm', 'module'], ['cjs', 'commonjs']]) {
  const target = join(dist, dir)
  mkdirSync(target, { recursive: true })
  writeFileSync(join(target, 'package.json'), `${JSON.stringify({ type }, null, 2)}\n`)
}
