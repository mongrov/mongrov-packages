#!/usr/bin/env node
/**
 * Build workspace siblings whose dist/ is missing, so tests work on a fresh
 * checkout.
 *
 * Packages resolve each other through their `exports` maps, which point at
 * dist/ (see `.github/workflows/ci.yml`, "Build workspace dependencies").
 * On a clean clone dist/ does not exist yet, so a test that imports a
 * sibling at runtime fails before a single assertion runs:
 *
 *     Error: Failed to load url @mongrov/types/device-events
 *
 * CI handles this with `pnpm --filter <pkg>^... run build` before every
 * test step. Locally nothing did, so `pnpm --filter @mongrov/analytics test`
 * on a fresh checkout was red until someone remembered to build types by
 * hand. This script is the local counterpart, wired in as `pretest`.
 *
 * Usage:
 *   node scripts/ensure-built.mjs @mongrov/types [@mongrov/db ...]
 *       Build the named packages if their dist/ is missing.
 *   node scripts/ensure-built.mjs
 *       Build every package that some other workspace package depends on
 *       (the union of CI's `^...` sets), if its dist/ is missing.
 *
 * Only a MISSING dist/ triggers a build. A stale dist/ is left alone, same
 * as in CI's per-package jobs — `pnpm --filter @mongrov/types run build`
 * refreshes it on demand. Rebuilding unconditionally would add the full
 * `prebuild` clean + two tsc passes to every test run, and two packages
 * doing that concurrently under `pnpm -r` would race on `rm -rf dist`.
 *
 * The root `pretest` runs the no-argument form, so `pnpm test` builds the
 * siblings once, sequentially, before `pnpm -r run test` fans out.
 */

import { spawnSync } from 'node:child_process'
import { existsSync, readdirSync, readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..')
const PACKAGES = join(ROOT, 'packages')

const packages = readdirSync(PACKAGES)
  .map(dir => ({ dir: join(PACKAGES, dir), manifest: join(PACKAGES, dir, 'package.json') }))
  .filter(({ manifest }) => existsSync(manifest))
  .map(({ dir, manifest }) => ({ dir, pkg: JSON.parse(readFileSync(manifest, 'utf8')) }))
  .filter(({ pkg }) => pkg.name && pkg.scripts?.build)

const byName = new Map(packages.map(p => [p.pkg.name, p]))

const requested = process.argv.slice(2)
const unknown = requested.filter(name => !byName.has(name))
if (unknown.length) {
  console.error(`ensure-built: not a buildable workspace package: ${unknown.join(', ')}`)
  process.exit(2)
}

const targets = requested.length
  ? requested.map(name => byName.get(name))
  : packages.filter(({ pkg }) => packages.some(other =>
      other.pkg !== pkg && [
        other.pkg.dependencies,
        other.pkg.devDependencies,
        other.pkg.peerDependencies,
      ].some(deps => deps && pkg.name in deps),
    ))

const missing = targets.filter(({ dir }) => !existsSync(join(dir, 'dist')))
if (!missing.length)
  process.exit(0)

const names = missing.map(({ pkg }) => pkg.name)
console.log(`ensure-built: dist/ missing for ${names.join(', ')} — building`)

// One pnpm invocation: pnpm orders multiple --filter targets topologically,
// so a dependency is built before the package that imports it.
const result = spawnSync(
  'pnpm',
  [...names.flatMap(name => ['--filter', name]), 'run', 'build'],
  { cwd: ROOT, stdio: 'inherit' },
)
process.exit(result.status ?? 1)
