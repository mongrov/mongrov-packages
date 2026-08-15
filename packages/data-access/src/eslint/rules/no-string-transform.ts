/**
 * `transform` must be a function, never a path string.
 *
 * The dispatcher resolves `transform` by CALLING it. A string is silently
 * ignored — so an entry whose output schema declares derived fields will pass
 * the raw engine row to Zod, miss those fields, and fail its own parse at
 * runtime. Nothing catches it earlier: the file compiles, the query
 * dispatches, and the string reads like a to-do that someone will honour.
 *
 * This has now been found three times by hand:
 *
 *   - `device.lastSyncedAt` shipped registered and unsatisfiable, its
 *     `sensorScene` never produced (zivaone_app finding #7).
 *   - The sprint6 spec's `queries.ts` carries 17 path-string transforms and
 *     zero function ones — every entry in it has the same defect.
 *   - `hrv.day` was about to be registered the same way.
 *
 * A comment naming a module that does not exist yet is not a transform. If
 * the derivation is unwritten, the honest options are to leave the entry out
 * or to declare an output the SQL alone satisfies — both of which fail loudly
 * rather than at a user's first query.
 */

import type { Rule } from 'eslint'

const DEFINERS = new Set(['defineQuery', 'defineMutation'])

const noStringTransform: Rule.RuleModule = {
  meta: {
    type: 'problem',
    docs: {
      description:
        'require `transform` to be a function — a path string is ignored by '
        + 'the dispatcher and leaves the entry unable to satisfy its own output schema',
    },
    schema: [],
    messages: {
      stringTransform:
        '`transform` is a string, which the dispatcher ignores. The raw row '
        + 'reaches the output parse unchanged, so any derived field this entry '
        + 'declares will be missing at runtime. Pass the derivation function '
        + 'itself, or remove the field from the output schema.',
    },
  },

  create(context) {
    return {
      Property(node) {
        // `transform: '...'` — string literal or template literal, either way
        // it is a path someone meant to wire up later.
        const key = node.key
        const isTransform
          = (key.type === 'Identifier' && key.name === 'transform')
            || (key.type === 'Literal' && key.value === 'transform')
        if (!isTransform)
          return

        const value = node.value
        const isString
          = (value.type === 'Literal' && typeof value.value === 'string')
            || value.type === 'TemplateLiteral'
        if (!isString)
          return

        // Only inside a registry definer, so an unrelated `transform: 'x'`
        // property elsewhere in an app is not this rule's business.
        if (!withinDefiner(node))
          return

        context.report({ node, messageId: 'stringTransform' })
      },
    }
  },
}

/** Walk up to find an enclosing `defineQuery(...)` / `defineMutation(...)`. */
function withinDefiner(node: Rule.Node): boolean {
  let current: Rule.Node | undefined = node.parent as Rule.Node | undefined
  while (current) {
    if (current.type === 'CallExpression') {
      const callee = current.callee
      if (callee.type === 'Identifier' && DEFINERS.has(callee.name))
        return true
      // `dataAccess.defineQuery(...)` reads the same way.
      if (callee.type === 'MemberExpression'
        && callee.property.type === 'Identifier'
        && DEFINERS.has(callee.property.name)) {
        return true
      }
    }
    current = current.parent as Rule.Node | undefined
  }
  return false
}

export default noStringTransform
