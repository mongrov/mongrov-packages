/**
 * T-21 + T-22 — RuleTester coverage for `no-storage-engine-imports`.
 *
 * Bridges ESLint's Mocha-style `RuleTester` to vitest by wiring
 * `RuleTester.describe` / `.it` before instantiating.
 */

import { RuleTester } from 'eslint'
import { describe, it } from 'vitest'

import rule from '../rules/no-storage-engine-imports'

// eslint 8 RuleTester expects describe/it in module scope.
;(RuleTester as unknown as { describe: unknown }).describe = describe
;(RuleTester as unknown as { it: unknown }).it = it

const tester = new RuleTester({
  parserOptions: {
    ecmaVersion: 2022,
    sourceType: 'module',
  },
})

tester.run('no-storage-engine-imports', rule, {
  valid: [
    // Non-blocked packages pass through untouched.
    { code: `import { useState } from 'react'` },
    { code: `import * as React from 'react'` },
    { code: `import { defineQuery } from '@mongrov/data-access'` },
    { code: `const foo = require('mitt')` },
    { code: `import('@tanstack/react-query').then(() => {})` },

    // Files inside an allowedDirs segment may import blocked packages
    // (this is how the registry itself wires engine adapters).
    {
      code: `import { openDb } from '@mongrov/db'`,
      filename: '/repo/src/data/queries/index.ts',
      options: [{ allowedDirs: ['src/data'] }],
    },
    {
      code: `import { openKv } from '@mongrov/db/kv'`,
      filename: '/repo/src/data/registry.ts',
      options: [{ allowedDirs: ['src/data'] }],
    },
    {
      code: `import { track } from '@mongrov/analytics'`,
      filename: '/repo/src/data/mutations/track.ts',
      options: [{ allowedDirs: ['src/data'] }],
    },

    // Custom blockedPackages replaces the default list; @mongrov/db is
    // no longer blocked when the caller opts out.
    {
      code: `import { openDb } from '@mongrov/db'`,
      options: [{ blockedPackages: ['some-other-pkg'] }],
    },
  ],
  invalid: [
    // Direct import of a blocked package from a screen file.
    {
      code: `import { openDb } from '@mongrov/db'`,
      filename: '/repo/src/features/hrv/screen.tsx',
      errors: [{ messageId: 'blockedImport' }],
    },
    // Subpath import — `@mongrov/db/kv` is caught by the prefix match.
    {
      code: `import { openKv } from '@mongrov/db/kv'`,
      filename: '/repo/src/features/hrv/screen.tsx',
      errors: [{ messageId: 'blockedImport' }],
    },
    // @mongrov/analytics is on the default block list.
    {
      code: `import { track } from '@mongrov/analytics'`,
      filename: '/repo/src/features/hrv/screen.tsx',
      errors: [{ messageId: 'blockedImport' }],
    },
    // @mongrov/collab is on the default block list.
    {
      code: `import { openRoom } from '@mongrov/collab'`,
      filename: '/repo/src/features/hrv/screen.tsx',
      errors: [{ messageId: 'blockedImport' }],
    },
    // Dynamic import().
    {
      code: `const load = () => import('@mongrov/db')`,
      filename: '/repo/src/features/hrv/screen.tsx',
      errors: [{ messageId: 'blockedImport' }],
    },
    // CommonJS require().
    {
      code: `const db = require('@mongrov/db')`,
      filename: '/repo/src/features/hrv/screen.tsx',
      errors: [{ messageId: 'blockedImport' }],
    },
    // allowedDirs miss — file is NOT under an allowed segment.
    {
      code: `import { openDb } from '@mongrov/db'`,
      filename: '/repo/src/features/hrv/screen.tsx',
      options: [{ allowedDirs: ['src/data'] }],
      errors: [{ messageId: 'blockedImport' }],
    },
  ],
})

// T-22 — schema shape. `additionalProperties: false` prevents typos
// (e.g. `allowedDir` vs `allowedDirs`) and the string[] shape guards
// against misconfiguration. We assert directly on the exported rule so
// the shape doesn't quietly drift.
describe('config schema', () => {
  it('exposes an object schema with the documented keys', () => {
    const schema = rule.meta?.schema
    if (!Array.isArray(schema) || schema.length !== 1) {
      throw new Error('expected rule.meta.schema to be a single-element tuple')
    }
    const optionSchema = schema[0] as Record<string, unknown>
    if (optionSchema.type !== 'object') {
      throw new Error('expected the options schema to declare type: "object"')
    }
    if (optionSchema.additionalProperties !== false) {
      throw new Error(
        'expected additionalProperties: false so typos are rejected'
      )
    }
    const props = optionSchema.properties as
      | Record<string, { type: string; items?: { type: string } }>
      | undefined
    if (!props || !props.allowedDirs || !props.blockedPackages) {
      throw new Error(
        'expected properties.allowedDirs and properties.blockedPackages'
      )
    }
    if (props.allowedDirs.type !== 'array' || props.allowedDirs.items?.type !== 'string') {
      throw new Error('expected allowedDirs to be string[]')
    }
    if (
      props.blockedPackages.type !== 'array' ||
      props.blockedPackages.items?.type !== 'string'
    ) {
      throw new Error('expected blockedPackages to be string[]')
    }
  })
})
