/**
 * The message a caller gets for arguments the tool's schema refuses.
 *
 * Written for a model to correct itself in one more call: it names each
 * field, the values the field accepts (read from the same JSON Schema the
 * caller was shown, so the two never disagree) and what was sent. Works for
 * zod 3 and zod 4 alike: only `issues[].path` is read from the error, and
 * the rest comes from the JSON Schema.
 */

interface IssueLike {
  path: readonly PropertyKey[]
  message: string
}

type JsonProp = Record<string, unknown>

const PREFIX = 'Invalid arguments: '

/** What a JSON Schema property accepts, in words ("a whole number from 1 to 90"). */
export function describeAccepted(prop: JsonProp | undefined): string | null {
  if (!prop)
    return null
  const values = prop.enum
  if (Array.isArray(values) && values.length > 0)
    return `one of ${values.map(v => JSON.stringify(v)).join(', ')}`
  if (prop.type === 'integer' || prop.type === 'number') {
    const kind = prop.type === 'integer' ? 'a whole number' : 'a number'
    const min = typeof prop.minimum === 'number' ? prop.minimum : null
    const max = typeof prop.maximum === 'number' ? prop.maximum : null
    const xmin = typeof prop.exclusiveMinimum === 'number' ? prop.exclusiveMinimum : null
    const xmax = typeof prop.exclusiveMaximum === 'number' ? prop.exclusiveMaximum : null
    if (min !== null && max !== null)
      return `${kind} from ${min} to ${max}`
    const parts: string[] = []
    if (min !== null)
      parts.push(`at least ${min}`)
    if (xmin !== null)
      parts.push(`above ${xmin}`)
    if (max !== null)
      parts.push(`at most ${max}`)
    if (xmax !== null)
      parts.push(`below ${xmax}`)
    return parts.length > 0 ? `${kind}, ${parts.join(' and ')}` : kind
  }
  if (prop.type === 'string')
    return 'a string'
  if (prop.type === 'boolean')
    return 'true or false'
  return null
}

function shown(value: unknown): string {
  const text = JSON.stringify(value) ?? String(value)
  return text.length > 40 ? `${text.slice(0, 37)}...` : text
}

/**
 * `Invalid arguments: days must be a whole number from 1 to 90 (got 0).`
 * One clause per field, in the order the schema reported them.
 */
export function describeInvalidArgs(
  error: { issues?: readonly IssueLike[] },
  schema: Record<string, unknown>,
  input?: unknown,
): string {
  if (input !== undefined && (input === null || typeof input !== 'object' || Array.isArray(input)))
    return `${PREFIX}send the arguments as an object.`
  const props = (schema.properties ?? {}) as Record<string, JsonProp>
  const sent = (input ?? {}) as Record<string, unknown>
  const clauses: string[] = []
  const seen = new Set<string>()
  for (const issue of error.issues ?? []) {
    const field = issue.path.length > 0 ? String(issue.path[0]) : ''
    if (seen.has(field))
      continue
    seen.add(field)
    const accepted = describeAccepted(props[field])
    if (!field || !accepted) {
      clauses.push(field ? `${field}: ${issue.message}` : issue.message)
      continue
    }
    clauses.push(sent[field] === undefined
      ? `${field} is required and must be ${accepted}`
      : `${field} must be ${accepted} (got ${shown(sent[field])})`)
  }
  if (clauses.length === 0)
    return `${PREFIX}they do not match the tool's schema.`
  return `${PREFIX}${clauses.join('; ')}.`
}
