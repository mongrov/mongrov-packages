import { RuleTester } from 'eslint'
import { describe, it } from 'vitest'

import rule from '../rules/no-string-transform'

;

(RuleTester as unknown as { describe: unknown }).describe = describe
;(RuleTester as unknown as { it: unknown }).it = it

const tester = new RuleTester({
  parserOptions: { ecmaVersion: 2022, sourceType: 'module' },
})

describe('no-string-transform', () => {
  it('accepts functions and rejects path strings', () => {
    tester.run('no-string-transform', rule, {
      valid: [
        // The correct shape.
        { code: `defineQuery({ transform: raw => derive(raw) })` },
        { code: `defineQuery({ transform: function (raw) { return derive(raw) } })` },
        // No transform at all is fine — the SQL satisfies the output alone.
        { code: `defineQuery({ sql: 'SELECT 1' })` },
        // Outside a registry definer this rule has no opinion.
        { code: `const config = { transform: 'some/path.ts' }` },
        { code: `doSomething({ transform: 'x' })` },
      ],
      invalid: [
        {
          code: `defineQuery({ transform: 'src/features/spo2/utils/derive-sensor.ts' })`,
          errors: [{ messageId: 'stringTransform' }],
        },
        {
          // Template literals read as paths too. The fixture has to CONTAIN a
          // template path — that is the thing under test — so the lint rule
          // about template syntax in strings is legitimately inapplicable.
          // eslint-disable-next-line no-template-curly-in-string
          code: 'defineQuery({ transform: `src/${x}/derive.ts` })',
          errors: [{ messageId: 'stringTransform' }],
        },
        {
          code: `defineMutation({ transform: 'path.ts' })`,
          errors: [{ messageId: 'stringTransform' }],
        },
        {
          // Nested inside the definer's argument, which is where they live.
          code: `defineQuery({ engine: 'duckdb', output: z.object({}), transform: 'a.ts' })`,
          errors: [{ messageId: 'stringTransform' }],
        },
      ],
    })
  })
})
