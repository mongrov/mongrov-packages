/**
 * The on-device JSON Schema subset: what a tool's input schema may use so an
 * on-device model's bridge accepts it whole.
 *
 * `parseLikeAppleBridge` replicates, rule for rule, the schema parser of
 * `@react-native-ai/apple` 0.12 (`AppleLLMSchemaParser` in
 * `ios/AppleLLMImpl.swift`), which turns each tool's JSON Schema into a
 * Foundation Models `GenerationSchema` before any generation. That parser
 * cannot run in node, so its rules are copied here; a change upstream is a
 * one-file diff. What it does:
 *
 *   - `anyOf` (checked first): a union of the parsed members;
 *   - `type` must be ONE string of object / array / string / number /
 *     integer / boolean, otherwise it throws "Unsupported schema type" —
 *     so `type: "null"`, a `type` array (what `.nullable()` emits), a node
 *     with no `type` (`$ref`, `oneOf`, `allOf`, `{}`) all fail, and one
 *     failing tool fails the whole request (every tool is lost);
 *   - object: every `properties` entry parsed; `required` read;
 *   - array: `items` required (throws without), `minItems`/`maxItems` kept;
 *   - string: an all-string `enum` becomes a choice; else `pattern` is
 *     compiled as a Swift `Regex` (throws when it does not compile); else
 *     a free string;
 *   - number / integer: an all-string `enum` only; `multipleOf` throws;
 *     then the FIRST of `maximum`, `minimum`, `exclusiveMaximum`,
 *     `exclusiveMinimum` present is kept and the rest are dropped;
 *   - `default`, `format`, `minLength`, `maxLength`, `const`,
 *     `additionalProperties` are ignored; property order is lost (a Swift
 *     dictionary).
 *
 * `lintToolInputSchema` reports those failures and losses as errors, plus a
 * few house rules (one level of nesting, string-only unions, short field
 * descriptions) that keep a definition small and unambiguous for a small
 * model. `defineTool` runs it in dev and test and throws on any error.
 */

export interface LintIssue {
  readonly level: 'error' | 'warning'
  /** Dotted JSON path of the node, `''` for the root. */
  readonly path: string
  readonly rule: string
  readonly message: string
}

export interface BridgeParseResult {
  /** The bridge's own error message when it would throw (and fail the request); else null. */
  readonly error: string | null
  /** Constraints the bridge silently drops, as `path: keyword`. */
  readonly lost: readonly string[]
}

type Json = Record<string, unknown>

const SUPPORTED = ['object', 'array', 'string', 'number', 'integer', 'boolean']
const NUMERIC_BOUNDS = ['maximum', 'minimum', 'exclusiveMaximum', 'exclusiveMinimum'] as const
const IGNORED_KEYWORDS = ['format', 'minLength', 'maxLength', 'const'] as const

/**
 * Regex features outside the subset both JS and Swift `Regex` read the same
 * way. The bridge compiles the pattern in Swift; keep to anchors,
 * alternation, groups, classes, `\d` / `\w` / `\s` and counted repeats.
 */
const UNPORTABLE_REGEX: readonly [RegExp, string][] = [
  [/\(\?<[=!]/, 'lookbehind'],
  [/\(\?<[A-Z_]/i, 'named group'],
  [/\\p\{/i, 'Unicode property escape'],
  [/\\[1-9]/, 'backreference'],
  [/\\k</, 'named backreference'],
]

function isAllStrings(v: unknown): v is string[] {
  return Array.isArray(v) && v.every(x => typeof x === 'string')
}

const join = (path: string, key: string): string => (path ? `${path}.${key}` : key)

/** Replicates `AppleLLMSchemaParser.parseDynamicSchema` (see the file comment). */
export function parseLikeAppleBridge(schema: Json): BridgeParseResult {
  const lost: string[] = []
  const walk = (node: Json, path: string): void => {
    if (Array.isArray(node.anyOf)) {
      ;(node.anyOf as unknown[]).forEach((m, i) => {
        if (m === null || typeof m !== 'object' || Array.isArray(m))
          throw new Error(`Unsupported schema type: unknown. Supported types: ${SUPPORTED.join(', ')}`)
        walk(m as Json, join(path, `anyOf.${i}`))
      })
      return
    }
    const type = typeof node.type === 'string' ? node.type : undefined
    switch (type) {
      case 'object': {
        const props = node.properties
        if (props !== null && typeof props === 'object' && !Array.isArray(props)) {
          for (const [name, prop] of Object.entries(props as Json)) {
            if (prop === null || typeof prop !== 'object' || Array.isArray(prop))
              throw new Error(`Property ${name} schema must be an object`)
            walk(prop as Json, join(path, name))
          }
        }
        return
      }
      case 'array': {
        if (node.items === null || typeof node.items !== 'object' || Array.isArray(node.items))
          throw new Error('Array schema must have items definition')
        walk(node.items as Json, join(path, 'items'))
        return
      }
      case 'string': {
        if (isAllStrings(node.enum))
          break
        if (node.enum !== undefined)
          lost.push(`${join(path, 'enum')}`)
        if (typeof node.pattern === 'string') {
          try {
            // expected: JS compiles what Swift would in the portable subset.
            void new RegExp(node.pattern)
          }
          catch (err) {
            throw new Error(`Invalid regex pattern '${node.pattern}': ${(err as Error).message}`)
          }
        }
        break
      }
      case 'number':
      case 'integer': {
        if (isAllStrings(node.enum))
          break
        if (node.enum !== undefined)
          lost.push(join(path, 'enum'))
        if (node.multipleOf !== undefined)
          throw new Error('MultipleOf is not supported by Apple Foundational models.')
        const present = NUMERIC_BOUNDS.filter(k => typeof node[k] === 'number')
        // The first present bound wins; every other is dropped.
        for (const k of present.slice(1))
          lost.push(join(path, k))
        break
      }
      case 'boolean':
        break
      default:
        throw new Error(`Unsupported schema type: ${type ?? 'unknown'}. Supported types: ${SUPPORTED.join(', ')}`)
    }
    for (const k of IGNORED_KEYWORDS) {
      if (node[k] !== undefined)
        lost.push(join(path, k))
    }
  }
  try {
    walk(schema, '')
    return { error: null, lost }
  }
  catch (err) {
    return { error: (err as Error).message, lost }
  }
}

export interface LintOptions {
  /** Max chars of a field `description`. Default 60. */
  maxFieldDescription?: number
  /** Max properties on the root. Default 5. */
  maxProperties?: number
}

/**
 * Lint a tool's INPUT JSON Schema (as `toJsonSchemaObject` builds it) against
 * the on-device subset. Errors make `defineTool` throw in dev and test.
 */
export function lintToolInputSchema(schema: Json, opts: LintOptions = {}): LintIssue[] {
  const issues: LintIssue[] = []
  const err = (path: string, rule: string, message: string): void => {
    issues.push({ level: 'error', path, rule, message })
  }
  const warn = (path: string, rule: string, message: string): void => {
    issues.push({ level: 'warning', path, rule, message })
  }
  const maxDesc = opts.maxFieldDescription ?? 60
  const maxProps = opts.maxProperties ?? 5

  if (schema.type !== 'object') {
    err('', 'root-object', 'the input schema must be an object')
    return issues
  }

  const bridge = parseLikeAppleBridge(schema)
  if (bridge.error)
    err('', 'bridge-throws', `the on-device bridge rejects this schema (${bridge.error}), and with it every tool in the request`)

  const node = (n: Json, path: string, depth: number): void => {
    if (Array.isArray(n.type))
      err(path, 'type-array', 'a type list (what .nullable() emits) is not supported; use .optional()')
    if (n.type === 'null')
      err(path, 'nullable', 'a null type is not supported; use .optional()')
    if (n.multipleOf !== undefined)
      err(path, 'multiple-of', 'multipleOf is not supported')
    if (n.$ref !== undefined || n.oneOf !== undefined || n.allOf !== undefined || n.not !== undefined)
      err(path, 'unsupported-keyword', '$ref, oneOf, allOf and not are not supported')
    if (n.type === undefined && n.anyOf === undefined && n.enum === undefined)
      err(path, 'no-type', 'every field needs a single type')

    if (Array.isArray(n.anyOf)) {
      const members = n.anyOf as Json[]
      if (!members.every(m => m && m.type === 'string'))
        err(path, 'union', 'a union must be of strings only (an enum is simpler)')
      members.forEach((m, i) => m && typeof m === 'object' && node(m, join(path, `anyOf.${i}`), depth))
    }

    if (n.type === 'number' || n.type === 'integer') {
      if (n.enum !== undefined && !isAllStrings(n.enum))
        err(path, 'numeric-enum', 'the bridge reads a numeric enum only as strings; use a string enum')
      const lower = typeof n.minimum === 'number' || typeof n.exclusiveMinimum === 'number'
      const upper = typeof n.maximum === 'number' || typeof n.exclusiveMaximum === 'number'
      if (lower && upper && n['x-boundsCheckedBy'] !== 'framework')
        err(path, 'both-bounds', 'the bridge keeps only one bound of a range (the maximum); prefer an enum or a pattern-checked string')
    }

    if (n.type === 'string') {
      if (n.enum !== undefined && !isAllStrings(n.enum))
        err(path, 'string-enum', 'a string enum must list strings')
      if (typeof n.pattern === 'string') {
        for (const [re, what] of UNPORTABLE_REGEX) {
          if (re.test(n.pattern))
            err(path, 'pattern-portable', `pattern uses a ${what}, which Swift Regex may read differently`)
        }
      }
      for (const k of ['format', 'minLength', 'maxLength', 'const'] as const) {
        if (n[k] !== undefined)
          warn(path, 'ignored-keyword', `${k} is ignored on device (the framework still checks it)`)
      }
    }

    if (path !== '' && typeof n.description === 'string' && n.description.length > maxDesc)
      warn(path, 'field-description', `description is ${n.description.length} chars (keep to ${maxDesc})`)

    if (n.type === 'object') {
      if (depth >= 1) {
        err(path, 'nesting', 'nested objects are not allowed in tool input (one level of fields only)')
        return
      }
      const props = (n.properties ?? {}) as Record<string, Json>
      const names = Object.keys(props)
      if (depth === 0 && names.length > maxProps)
        warn(path, 'property-count', `${names.length} properties (keep to ${maxProps})`)
      for (const name of names)
        node(props[name], join(path, name), depth + 1)
    }

    if (n.type === 'array') {
      const items = n.items as Json | undefined
      if (!items || typeof items !== 'object') {
        err(path, 'array-items', 'an array needs an items schema')
        return
      }
      if (items.type === 'object' || items.type === 'array')
        err(path, 'nesting', 'arrays of objects or arrays are not allowed in tool input')
      else
        node(items, join(path, 'items'), depth + 1)
    }
  }
  node(schema, '', 0)

  // Anything the bridge drops that the rules above did not already name.
  const named = new Set(issues.map(i => i.path))
  for (const l of bridge.lost) {
    const parent = l.slice(0, Math.max(0, l.lastIndexOf('.')))
    if (!named.has(parent) && !named.has(l))
      warn(parent, 'lost-constraint', `${l.slice(l.lastIndexOf('.') + 1)} is dropped on device`)
  }

  return issues
}
