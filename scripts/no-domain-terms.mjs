#!/usr/bin/env node
/**
 * Domain-term scan (techspec principle 73, package-separation S-02/S-04).
 *
 * mongrov-packages is domain-free: no brand, wearable or health concept in
 * any `@mongrov/*` package — not in code, types, table names, defaults,
 * rules, tools or fixtures. This lists every place one still appears.
 *
 * Words are matched per identifier part, so `getHRV`, `heart_rate` and
 * `SleepDeriver` are found while `string` or `during` are not.
 *
 *   node scripts/no-domain-terms.mjs                 report, exit 0
 *   node scripts/no-domain-terms.mjs --fail          exit 1 on any hit
 *   node scripts/no-domain-terms.mjs --json          machine-readable
 *   node scripts/no-domain-terms.mjs <dir> [<dir>]   scan these instead
 *
 * Scanned: `packages/<pkg>/src/**` (ts, tsx, js, mjs, toml, json), outside
 * test directories (`__tests__`, `__integration__`, `__fakes__`,
 * `__mocks__`) and the allowed `__tests__/packs/` fixtures.
 */

import { readdirSync, readFileSync, statSync } from 'node:fs'
import { join, relative } from 'node:path'
import process from 'node:process'

const ROOT = new URL('..', import.meta.url).pathname
const TERMS = new Set([
  // health and vitals
  'health',
  'vital',
  'vitals',
  'heart',
  'hrv',
  'spo2',
  'sleep',
  'temperature',
  'bpm',
  'stress',
  // wearable hardware
  'ring',
  'firmware',
  'wearable',
  'wrist',
  // brands
  'ziva',
  'zivaone',
  'luminx',
  'viva',
  'yogaring',
])
const SKIP_DIRS = new Set(['node_modules', 'dist', '__tests__', '__integration__', '__fakes__', '__mocks__', '__scratch__'])
const EXTENSIONS = /\.(?:ts|tsx|js|mjs|toml|json)$/
const NON_WORD_RE = /[^A-Z0-9]+/i
const CAMEL_RE = /(?<=[a-z0-9])(?=[A-Z])|(?<=[A-Z])(?=[A-Z][a-z])/
const SPO2_RE = /spo2/i

const args = process.argv.slice(2)
const fail = args.includes('--fail')
const json = args.includes('--json')
const dirs = args.filter(a => !a.startsWith('--'))
const roots = dirs.length > 0
  ? dirs.map(d => join(process.cwd(), d))
  : readdirSync(join(ROOT, 'packages')).map(p => join(ROOT, 'packages', p, 'src')).filter(d => exists(d))

function exists(p) {
  try {
    statSync(p)
    return true
  }
  catch {
    return false
  }
}

function* files(dir) {
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    if (entry.isDirectory()) {
      if (!SKIP_DIRS.has(entry.name))
        yield* files(join(dir, entry.name))
    }
    else if (EXTENSIONS.test(entry.name)) {
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

const hits = []
for (const root of roots) {
  for (const file of files(root)) {
    const lines = readFileSync(file, 'utf8').split('\n')
    lines.forEach((line, i) => {
      const found = [...new Set(words(line).filter(w => TERMS.has(w)))]
      // `SpO2` splits as sp|o2; catch it on the raw line.
      if (SPO2_RE.test(line) && !found.includes('spo2'))
        found.push('spo2')
      if (found.length > 0)
        hits.push({ file: relative(ROOT, file), line: i + 1, terms: found, text: line.trim().slice(0, 160) })
    })
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
  for (const [file, list] of [...byFile].sort((a, b) => b[1].length - a[1].length || a[0].localeCompare(b[0])))
    console.log(`${String(list.length).padStart(5)}  ${file}  [${[...new Set(list.flatMap(h => h.terms))].join(', ')}]`)
  console.log(`\n${hits.length} lines in ${byFile.size} files. By term: ${[...byTerm].sort((a, b) => b[1] - a[1]).map(([t, n]) => `${t} ${n}`).join(', ')}`)
}
process.exit(fail && hits.length > 0 ? 1 : 0)
