#!/usr/bin/env node
/**
 * Domain-term guard (techspec principle 73, package-separation S-02/S-04).
 *
 * mongrov-packages is domain-free: no brand, vendor, wearable or health
 * concept in any `@mongrov/*` package — not in code, types, table names,
 * defaults, rules, tools, fixtures, docs or package metadata. This lists
 * every place one still appears.
 *
 * Two kinds of match:
 *   - BRANDS are matched as a case-insensitive substring of the raw line, so
 *     `ZivaOneTheme`, `jcring_v2` and `@zivaone/health` are all found.
 *   - WORDS are matched per identifier part (camelCase, snake_case, kebab,
 *     plain prose), plural-insensitive: `getHRV`, `heart_rate`,
 *     `SleepDeriver`, `nights` are found while `string` or `during` are not.
 *
 * Modes:
 *   node scripts/no-domain-terms.mjs [--fail] [--json]
 *       Source mode. Every file under `packages/<pkg>/` (code, SQL, docs,
 *       READMEs, CHANGELOGs, UPGRADING, package.json, configs, `__fakes__`,
 *       `__mocks__`, tests) except `node_modules/` and `dist/`.
 *       Exempt by design (design.md "Guard"): `src/__tests__/packs/` — the
 *       test packs that stand in for a real domain pack.
 *       Exempt TEMPORARILY: the test files listed in
 *       `no-domain-terms.test-paths.json` (see that file). A listed file that
 *       no longer has a hit is reported as stale, and fails with --fail, so
 *       the list only shrinks.
 *
 *   node scripts/no-domain-terms.mjs --pack [<pkg-dir> ...] [--fail]
 *       Tarball mode, no path exemptions. For each publishable package
 *       (default: all of `packages/*`), asks npm which files `npm pack` would
 *       put in the tarball and scans exactly those. Needs a build (dist/).
 *
 *   node scripts/no-domain-terms.mjs --tarball <file.tgz> [...] [--fail]
 *       Tarball mode on packed tarballs: extracts each and scans every file
 *       in it, no path exemptions.
 *
 * Not domain terms, and so not reported (both modes):
 *   - `ring` followed by `buffer` (a ring buffer), `health` followed by
 *     `check` (a healthcheck);
 *   - the entries of `no-domain-terms.allow.json`: a path prefix (as
 *     `packages/<pkg>/…`; tarball files map to the same prefix), a term, an
 *     optional `match` regex the line must match, and the reason. Every entry
 *     needs a reason; add one only for a word used in a non-domain sense.
 */

import { execFileSync } from 'node:child_process'
import { mkdtempSync, readdirSync, readFileSync, rmSync, statSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, relative, resolve } from 'node:path'
import process from 'node:process'

const ROOT = new URL('..', import.meta.url).pathname

/** Brand, product and hardware-vendor names: substring, case-insensitive. */
const BRANDS = [
  'ziva', // ziva, zivaone, zivacore, @zivaone/*
  'luminx',
  'prana',
  'jstyle',
  'jcring',
  'colmi',
  'yogaring',
  'zivacore',
]

/** Domain words, matched per identifier part (plural-insensitive). */
const WORDS = new Set([
  // health and vitals
  'health',
  'healthy',
  'wellness',
  'vital',
  'vitals',
  'heart',
  'hr',
  'hrv',
  'rmssd',
  'spo2',
  'ppg',
  'oxygen',
  'blood',
  'pulse',
  'bpm',
  'sleep',
  'asleep',
  'sleeping',
  'awake',
  'steps',
  'kcal',
  'calorie',
  'celsius',
  'fahrenheit',
  'temperature',
  'stress',
  'readiness',
  'menstrual',
  'glucose',
  'resting',
  'motion',
  'night',
  'nightly',
  'overnight',
  // wearable hardware
  'ring',
  'firmware',
  'wearable',
  'wear',
  'worn',
  'unworn',
  'wrist',
  // brands that are also plain words
  'viva',
])
const SKIP_DIRS = new Set(['node_modules', 'dist', '.turbo', 'coverage'])
const EXTENSIONS = /\.(?:ts|tsx|mts|cts|js|jsx|mjs|cjs|sql|md|json|toml|ya?ml|txt|map)$/i
const NON_WORD_RE = /[^A-Z0-9]+/i
const CAMEL_RE = /(?<=[a-z0-9])(?=[A-Z])|(?<=[A-Z])(?=[A-Z][a-z])/
/** Spelled-out forms the word split misses: `SpO2` splits as sp|o2, `temp_c` as temp|c. */
const RAW_TERMS = [
  ['spo2', /spo2/i],
  ['temp_c', /\btemp_?c\b/i],
]
/** Design.md: the test packs stand in for a real domain pack. */
const SCOPE_RE = /^@[^/]+\//
const PACKS_TEST_DIR = /^packages\/[^/]+\/src\/__tests__\/packs\//

const ALLOW = JSON.parse(readFileSync(new URL('./no-domain-terms.allow.json', import.meta.url), 'utf8'))
  .map(a => ({ ...a, re: a.match ? new RegExp(a.match, 'i') : undefined }))
for (const a of ALLOW) {
  if (!a.reason)
    throw new Error(`no-domain-terms.allow.json: ${a.path} / ${a.term} has no reason`)
}
const TEST_PATHS_DOC = JSON.parse(readFileSync(new URL('./no-domain-terms.test-paths.json', import.meta.url), 'utf8'))
const TEST_PATHS = new Set(TEST_PATHS_DOC.paths)

function allowed(file, line, term) {
  return ALLOW.some(a => file.startsWith(a.path) && a.term === term && (!a.re || a.re.test(line)))
}

const args = process.argv.slice(2)
const fail = args.includes('--fail')
const json = args.includes('--json')
const packMode = args.includes('--pack')
const tarballMode = args.includes('--tarball')
const positional = args.filter(a => !a.startsWith('--'))

function exists(p) {
  try {
    statSync(p)
    return true
  }
  catch {
    return false
  }
}

/** Every file under `dir`; `skip` names directories not entered (none for a tarball). */
function* walk(dir, skip = SKIP_DIRS) {
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    if (entry.isDirectory()) {
      if (!skip.has(entry.name))
        yield* walk(join(dir, entry.name), skip)
    }
    else if (entry.isFile()) {
      yield join(dir, entry.name)
    }
  }
}

/** Identifier parts, lowercased: `getHRVBands` → get, hrv, bands; `heart_rate` → heart, rate. */
function words(line) {
  return line
    .split(NON_WORD_RE)
    .flatMap(token => token.split(CAMEL_RE))
    .map(w => w.toLowerCase())
    .filter(Boolean)
}

function isTerm(w) {
  if (WORDS.has(w))
    return w
  // plural / third person: nights, rings, calories, wears
  if (w.length > 3 && w.endsWith('s') && WORDS.has(w.slice(0, -1)))
    return w.slice(0, -1)
  if (w.length > 4 && w.endsWith('ies') && WORDS.has(`${w.slice(0, -3)}ie`))
    return `${w.slice(0, -3)}ie`
  return undefined
}

/** Terms on one line (before the allow-list). */
function termsOf(line) {
  const ws = words(line)
  const found = new Set()
  ws.forEach((w, j) => {
    const t = isTerm(w)
    if (!t)
      return
    if (t === 'ring' && ws[j + 1] === 'buffer')
      return // a ring buffer is a data structure, not a wearable
    if (t === 'health' && ws[j + 1] === 'check')
      return // a healthcheck
    found.add(t)
  })
  const lower = line.toLowerCase()
  for (const b of BRANDS) {
    if (lower.includes(b))
      found.add(b)
  }
  if (found.has('zivacore'))
    found.delete('ziva')
  for (const [t, re] of RAW_TERMS) {
    if (re.test(line))
      found.add(t)
  }
  return [...found]
}

/**
 * Scan one file. `rel` is the path used for reporting and the allow-list
 * (`packages/<pkg>/…`); `abs` is where to read it.
 */
function scanFile(abs, rel, hits) {
  const lines = readFileSync(abs, 'utf8').split('\n')
  let n = 0
  lines.forEach((line, i) => {
    const reported = termsOf(line).filter(t => !allowed(rel, line, t))
    if (reported.length > 0) {
      n++
      hits.push({ file: rel, line: i + 1, terms: reported, text: line.trim().slice(0, 160) })
    }
  })
  return n
}

function pkgDirs() {
  return readdirSync(join(ROOT, 'packages'))
    .map(p => join(ROOT, 'packages', p))
    .filter(d => exists(join(d, 'package.json')))
}

/** `packages/<short name>/` for a package name, so tarball files share the allow-list. */
function prefixFor(name) {
  return `packages/${name.replace(SCOPE_RE, '')}/`
}

const hits = []
const notes = []
const scanned = []

if (packMode) {
  const dirs = positional.length > 0 ? positional.map(d => resolve(d)) : pkgDirs()
  for (const dir of dirs) {
    const manifest = JSON.parse(readFileSync(join(dir, 'package.json'), 'utf8'))
    if (manifest.private)
      continue
    const out = execFileSync('npm', ['pack', '--dry-run', '--json', '--ignore-scripts'], { cwd: dir, encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] })
    const files = JSON.parse(out)[0].files.map(f => f.path)
    if (!files.some(f => f.startsWith('dist/')))
      throw new Error(`${manifest.name}: the tarball has no dist/ — build before --pack`)
    for (const f of files) {
      if (EXTENSIONS.test(f) || !/\.[a-z0-9]+$/i.test(f))
        scanFile(join(dir, f), prefixFor(manifest.name) + f, hits)
      else
        notes.push(`${manifest.name}: not scanned (binary/unknown type): ${f}`)
    }
    scanned.push(`${manifest.name}@${manifest.version} (${files.length} files)`)
  }
}
else if (tarballMode) {
  if (positional.length === 0)
    throw new Error('--tarball needs one or more .tgz paths')
  for (const tgz of positional) {
    const tmp = mkdtempSync(join(tmpdir(), 'no-domain-terms-'))
    try {
      execFileSync('tar', ['-xzf', resolve(tgz), '-C', tmp])
      const base = join(tmp, 'package')
      const manifest = JSON.parse(readFileSync(join(base, 'package.json'), 'utf8'))
      let count = 0
      for (const abs of walk(base, new Set())) {
        count++
        // A tarball file of an unscannable type is reported, not skipped silently.
        if (!EXTENSIONS.test(abs) && /\.[a-z0-9]+$/i.test(abs)) {
          notes.push(`${tgz}: not scanned (binary/unknown type): ${relative(base, abs)}`)
          continue
        }
        scanFile(abs, prefixFor(manifest.name) + relative(base, abs), hits)
      }
      scanned.push(`${manifest.name}@${manifest.version} (${count} files) ← ${tgz}`)
    }
    finally {
      rmSync(tmp, { recursive: true, force: true })
    }
  }
}
else {
  const dirs = positional.length > 0 ? positional.map(d => resolve(d)) : pkgDirs()
  const testHits = new Map()
  for (const dir of dirs) {
    for (const abs of walk(dir)) {
      if (!EXTENSIONS.test(abs))
        continue
      const rel = relative(ROOT, abs)
      if (PACKS_TEST_DIR.test(rel))
        continue
      if (TEST_PATHS.has(rel)) {
        testHits.set(rel, scanFile(abs, rel, []))
        continue
      }
      scanFile(abs, rel, hits)
    }
    scanned.push(relative(ROOT, dir) || dir)
  }
  if (positional.length === 0) {
    for (const p of TEST_PATHS) {
      if (!exists(join(ROOT, p)))
        hits.push({ file: 'scripts/no-domain-terms.test-paths.json', line: 0, terms: ['stale'], text: `listed test path no longer exists: ${p}` })
      else if (testHits.get(p) === 0)
        hits.push({ file: 'scripts/no-domain-terms.test-paths.json', line: 0, terms: ['stale'], text: `listed test path has no domain term any more — remove it from the list: ${p}` })
    }
    notes.push(`${TEST_PATHS.size} test files temporarily exempt (scripts/no-domain-terms.test-paths.json); src/__tests__/packs/ exempt by design.`)
  }
}

if (json) {
  console.log(JSON.stringify(hits, null, 1))
}
else {
  const byFile = new Map()
  for (const h of hits) byFile.set(h.file, [...(byFile.get(h.file) ?? []), h])
  const byTerm = new Map()
  for (const h of hits) {
    for (const t of h.terms) byTerm.set(t, (byTerm.get(t) ?? 0) + 1)
  }
  const verbose = args.includes('--lines')
  for (const [file, list] of [...byFile].sort((a, b) => b[1].length - a[1].length || a[0].localeCompare(b[0]))) {
    console.log(`${String(list.length).padStart(5)}  ${file}  [${[...new Set(list.flatMap(h => h.terms))].join(', ')}]`)
    if (verbose || fail) {
      for (const h of list) console.log(`         ${h.line}: ${h.text}`)
    }
  }
  const mode = packMode ? 'pack' : tarballMode ? 'tarball' : 'source'
  for (const n of notes) console.log(n)
  console.log(`\n[${mode}] scanned: ${scanned.join(', ')}`)
  console.log(`${hits.length} lines in ${byFile.size} files.${hits.length ? ` By term: ${[...byTerm].sort((a, b) => b[1] - a[1]).map(([t, n]) => `${t} ${n}`).join(', ')}` : ''}`)
}
// exitCode, not exit(): a piped stdout must drain first.
process.exitCode = fail && hits.length > 0 ? 1 : 0
