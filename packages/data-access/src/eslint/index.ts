/**
 * ESLint plugin barrel — `@mongrov/data-access/eslint`.
 *
 * Exposes rule modules under `rules` and a `recommended` flat-config
 * shape under `configs.recommended` that turns the rule on at `'error'`
 * severity. Consumers wire it up like:
 *
 * ```js
 * // eslint.config.mjs
 * import dataAccessPlugin from '@mongrov/data-access/eslint'
 *
 * export default [
 *   {
 *     plugins: { '@mongrov/data-access': dataAccessPlugin },
 *     rules: {
 *       '@mongrov/data-access/no-storage-engine-imports': ['error', {
 *         allowedDirs: ['src/data'],
 *       }],
 *     },
 *   },
 * ]
 * ```
 *
 * See data-access/spec.md §ESLint plugin.
 */

import noStorageEngineImports from './rules/no-storage-engine-imports'

const PLUGIN_NAME = '@mongrov/data-access'

const rules = {
  'no-storage-engine-imports': noStorageEngineImports,
} as const

const configs = {
  recommended: {
    plugins: [PLUGIN_NAME],
    rules: {
      [`${PLUGIN_NAME}/no-storage-engine-imports`]: 'error',
    },
  },
} as const

const plugin = {
  rules,
  configs,
}

export { configs, rules }
export default plugin
