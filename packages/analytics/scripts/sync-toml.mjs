#!/usr/bin/env node
/**
 * Sync `src/rules/defaults/<brand>.toml` into the `TOML` template literal
 * inside `src/rules/defaults/<brand>.ts`.
 *
 * Why this exists: the TOML catalogs are the authored source of truth
 * (rules are content, not code — analytics-rules/spec.md §Brand defaults),
 * but Metro and tsup do not resolve `.toml` imports, so each catalog is
 * mirrored into a TypeScript template literal that the bundler can see.
 * Two copies means they can drift; this script regenerates the mirror, and
 * `__tests__/defaults.test.ts` fails CI when they disagree.
 *
 *   node scripts/sync-toml.mjs          # rewrite every wrapper
 *   node scripts/sync-toml.mjs --check  # exit 1 if any is stale
 */

import { readFileSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const HERE = dirname(fileURLToPath(import.meta.url))
const DEFAULTS_DIR = join(HERE, '..', 'src', 'rules', 'defaults')

export const BRANDS = ['ziva', 'luminx', 'viva', 'yogaring']

/**
 * Escape a TOML body for embedding in a backtick template literal.
 * Catalogs are plain ASCII config, but backslashes, backticks and `${`
 * would otherwise change meaning.
 */
const BACKSLASH_RE = /\\/g
const BACKTICK_RE = /`/g
const TEMPLATE_OPEN_RE = /\$\{/g

export function escapeForTemplate(toml) {
  return toml
    .replace(BACKSLASH_RE, '\\\\')
    .replace(BACKTICK_RE, '\\`')
    .replace(TEMPLATE_OPEN_RE, '\\${')
}

/** Splice a fresh TOML body into an existing wrapper's `const TOML = ...`. */
export function spliceWrapper(wrapperSource, toml) {
  const body = escapeForTemplate(toml)
  const start = wrapperSource.indexOf('const TOML = `')
  if (start === -1) {
    throw new Error('wrapper has no `const TOML = \\`` literal to splice')
  }
  const bodyStart = start + 'const TOML = `'.length
  // The literal is terminated by the first unescaped backtick after it.
  let end = bodyStart
  for (;;) {
    end = wrapperSource.indexOf('`', end)
    if (end === -1)
      throw new Error('unterminated TOML template literal')
    if (wrapperSource[end - 1] !== '\\')
      break
    end += 1
  }
  return (
    `${wrapperSource.slice(0, bodyStart)}\n${body}${wrapperSource.slice(end)}`
  )
}

function main() {
  const check = process.argv.includes('--check')
  let stale = 0

  for (const brand of BRANDS) {
    const tomlPath = join(DEFAULTS_DIR, `${brand}.toml`)
    const tsPath = join(DEFAULTS_DIR, `${brand}.ts`)
    const toml = readFileSync(tomlPath, 'utf-8')
    const current = readFileSync(tsPath, 'utf-8')
    const next = spliceWrapper(current, toml)

    if (next === current) {
      console.log(`  ok      ${brand}`)
      continue
    }
    stale += 1
    if (check) {
      console.error(`  STALE   ${brand}.ts does not match ${brand}.toml`)
    }
    else {
      writeFileSync(tsPath, next)
      console.log(`  synced  ${brand}`)
    }
  }

  if (check && stale > 0) {
    console.error(
      `\n${stale} wrapper(s) out of sync. Run: node scripts/sync-toml.mjs`,
    )
    process.exit(1)
  }
}

// Only run when invoked directly, so the helpers stay importable by tests.
if (process.argv[1] && process.argv[1].endsWith('sync-toml.mjs')) {
  main()
}
