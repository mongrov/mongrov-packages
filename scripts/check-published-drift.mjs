#!/usr/bin/env node
/**
 * Guard against the two failure modes that made @mongrov/analytics@0.8.0
 * unusable outside this workspace.
 *
 * CI cannot catch either one by building the workspace, because in the
 * workspace every `@mongrov/*` dependency is a symlink to the local source.
 * `@mongrov/types/kv-keys` always resolves here. It did not resolve for
 * anyone installing from npm, and nothing failed until QA hit Metro.
 *
 * CHECK 1 — published-version drift.
 *   A version already on the registry must not differ from the local one.
 *   `8df2e58` added the `./kv-keys` export 4h44m AFTER types@0.5.0 was
 *   published, with no bump, so the registry's 0.5.0 and the repo's 0.5.0
 *   became different packages. Every later consumer built against a
 *   version of types that no installer could ever obtain.
 *
 * CHECK 2 — cross-package subpath resolvability.
 *   Every `@mongrov/X/sub` imported from built output must be exported by
 *   the published X that satisfies this package's declared range. This is
 *   the direct symptom, checked independently of check 1 so a hand-edited
 *   range is caught too.
 *
 * CHECK 3 — ambient declarations shadowing real types.
 *   Same class of mistake, different surface: @mongrov/ai carried a
 *   hand-written `declare module 'react-native-gifted-chat'` ending in
 *   `[key: string]: unknown`, so ChatScreen type-checked against a fiction
 *   and the app and the package silently resolved different majors.
 *   Declaring a subpath the package ships no types for stays allowed.
 *
 * Exit codes: 0 clean, 1 violations, 2 harness error (network, bad JSON).
 */

import { execFileSync } from 'node:child_process'
import { readdirSync, readFileSync, existsSync, statSync } from 'node:fs'
import { join, dirname, relative } from 'node:path'
import { fileURLToPath } from 'node:url'

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..')
const PACKAGES = join(ROOT, 'packages')

const red = s => `[31m${s}[39m`
const yellow = s => `[33m${s}[39m`
const dim = s => `[2m${s}[22m`

/** `npm view` with a null result for "not published", rather than a throw. */
function npmView(spec, field) {
  try {
    const out = execFileSync('npm', ['view', spec, field, '--json'], {
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'ignore'],
    }).trim()
    return out ? JSON.parse(out) : null
  }
  catch {
    return null
  }
}

function readJson(path) {
  return JSON.parse(readFileSync(path, 'utf8'))
}

/**
 * Highest published version of `name` satisfying `range`, or null.
 *
 * `npm view pkg@<range> version` returns a bare string when exactly one
 * version matches and an ARRAY when several do — so this cannot be read
 * directly without normalising, and the array case only appears once a
 * second matching version exists (i.e. right after the fix this script
 * exists to enforce).
 */
function highestMatching(name, range) {
  const result = npmView(`${name}@${range}`, 'version')
  if (result === null) return null
  return Array.isArray(result) ? result[result.length - 1] : result
}

/** Every file under dir, recursively. */
function walk(dir, out = []) {
  if (!existsSync(dir)) return out
  for (const entry of readdirSync(dir)) {
    const full = join(dir, entry)
    if (statSync(full).isDirectory()) walk(full, out)
    else out.push(full)
  }
  return out
}

const localPackages = readdirSync(PACKAGES)
  .map(name => join(PACKAGES, name, 'package.json'))
  .filter(existsSync)
  .map(p => ({ dir: dirname(p), pkg: readJson(p) }))
  .filter(({ pkg }) => !pkg.private && pkg.name)

const violations = []

// ---------------------------------------------------------------- check 1
for (const { pkg } of localPackages) {
  const published = npmView(`${pkg.name}@${pkg.version}`, 'version')
  if (!published) continue // not published at this version — nothing to drift from

  const remoteExports = npmView(`${pkg.name}@${pkg.version}`, 'exports')
  const localKeys = Object.keys(pkg.exports ?? {}).sort()
  const remoteKeys = Object.keys(remoteExports ?? {}).sort()

  const added = localKeys.filter(k => !remoteKeys.includes(k))
  const removed = remoteKeys.filter(k => !localKeys.includes(k))

  if (added.length || removed.length) {
    violations.push(
      `${red('DRIFT')} ${pkg.name}@${pkg.version} is already published, but its `
      + `exports differ from the registry.\n`
      + (added.length ? `        local adds:    ${added.join(', ')}\n` : '')
      + (removed.length ? `        local removes: ${removed.join(', ')}\n` : '')
      + `        ${dim('Bump the version and republish. A published version is immutable;')}\n`
      + `        ${dim('editing it in-repo makes the registry and the source diverge silently.')}`,
    )
  }
}

// ---------------------------------------------------------------- check 2
/**
 * Only real import positions — `from '…'`, `require('…')`, `import('…')`.
 *
 * A bare /@mongrov\/x\/y/ scan matches prose too: these packages document
 * their own wiring in header comments ("the app wires this to
 * `@mongrov/analytics/sync`"), which produced four false positives on the
 * first run and would have taught everyone to ignore this check.
 */
const SUBPATH_IMPORT
  = /(?:from\s*|require\(\s*|import\(\s*)['"]@mongrov\/([a-z-]+)\/([a-z-]+)['"]/g

for (const { dir, pkg } of localPackages) {
  const dist = join(dir, 'dist')
  if (!existsSync(dist)) continue

  const ranges = { ...pkg.dependencies, ...pkg.peerDependencies }
  const seen = new Set()

  for (const file of walk(dist)) {
    if (!/\.(js|cjs|mjs|d\.ts)$/.test(file)) continue
    const source = readFileSync(file, 'utf8')
    for (const [, dep, sub] of source.matchAll(SUBPATH_IMPORT)) {
      const target = `@mongrov/${dep}`
      if (target === pkg.name) continue
      const key = `${target}/${sub}`
      if (seen.has(key)) continue
      seen.add(key)

      const range = ranges[target]
      if (!range) {
        violations.push(
          `${red('UNDECLARED')} ${pkg.name} imports ${key} but does not depend on ${target}.\n`
          + `        ${dim(relative(ROOT, file))}`,
        )
        continue
      }
      // workspace:* is rewritten at pack time to the local version.
      const resolved = range === 'workspace:*'
        ? localPackages.find(p => p.pkg.name === target)?.pkg.version
        : range

      // A range matching several published versions makes `npm view` return
      // one result PER version, as an array. Collapse to the highest match
      // first — the version an installer would actually get — so the exports
      // lookup below is always a single object.
      const concrete = highestMatching(target, resolved)
      const remoteExports = concrete
        ? npmView(`${target}@${concrete}`, 'exports')
        : null
      if (remoteExports === null) {
        violations.push(
          `${yellow('UNPUBLISHED')} ${pkg.name} imports ${key}, but `
          + `${target}@${resolved} is not on the registry yet.\n`
          + `        ${dim('Publish it before publishing ' + pkg.name + '.')}`,
        )
        continue
      }
      if (!Object.keys(remoteExports).includes(`./${sub}`)) {
        violations.push(
          `${red('MISSING SUBPATH')} ${pkg.name} imports ${key}, but the published\n`
          + `        ${target}@${resolved} does not export ./${sub}.\n`
          + `        ${dim('Resolves in this workspace via symlink; fails for every installer.')}\n`
          + `        ${dim(relative(ROOT, file))}`,
        )
      }
    }
  }
}

// ---------------------------------------------------------------- check 3
// Ambient `declare module 'x'` that shadows a package shipping its own types.
//
// @mongrov/ai carried a hand-written declaration for react-native-gifted-chat
// ending in `[key: string]: unknown`. It shadowed the real types, so any prop
// compiled — and the package was type-checked against a fiction while the app
// and the package silently resolved different majors.
//
// Declaring a SUBPATH the package ships no types for is legitimate and stays
// allowed (e.g. '@iarna/toml/parse-string.js'). Shadowing the package root,
// when that root has types, is not.
for (const { dir, pkg } of localPackages) {
  const src = join(dir, 'src')
  for (const file of walk(src)) {
    if (!file.endsWith('.d.ts')) continue
    const text = readFileSync(file, 'utf8')
    for (const [, spec] of text.matchAll(/declare\s+module\s+['"]([^'"]+)['"]/g)) {
      // Subpath declarations are the legitimate case — skip them.
      const isSubpath = spec.includes('/')
        && !(spec.startsWith('@') && spec.split('/').length === 2)
      if (isSubpath) continue

      let shipsTypes = false
      try {
        const meta = readJson(join(dir, 'node_modules', spec, 'package.json'))
        shipsTypes = Boolean(meta.types || meta.typings || meta.exports)
      }
      catch {
        try {
          const meta = readJson(join(ROOT, 'node_modules', spec, 'package.json'))
          shipsTypes = Boolean(meta.types || meta.typings || meta.exports)
        }
        catch { shipsTypes = false }
      }

      if (shipsTypes) {
        violations.push(
          `${red('SHADOWED TYPES')} ${pkg.name} declares an ambient module for `
          + `'${spec}', but that package ships its own types.\n`
          + `        ${dim('The declaration wins, so this package is type-checked against')}\n`
          + `        ${dim('a local description instead of the real API. Delete it.')}\n`
          + `        ${dim(relative(ROOT, file))}`,
        )
      }
    }
  }
}

if (violations.length) {
  console.error(`\n${red(`${violations.length} publish-safety violation(s):`)}\n`)
  for (const v of violations) console.error(`  ${v}\n`)
  process.exit(1)
}

console.log('✓ no published-version drift, all @mongrov subpath imports resolvable')
