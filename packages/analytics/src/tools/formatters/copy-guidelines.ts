/**
 * User-language guardrails for tool output (Sprint 5 §5 / T-29, Ziva #2,
 * principle 37).
 *
 * Tool output goes into an LLM's context, and the LLM will parrot whatever
 * register it finds there. If a formatter says "2 desaturation events", the
 * assistant tells the user they had two desaturation events — which is
 * clinical language Ziva is not licensed to speak and the user did not ask
 * for. The fix is upstream of the model: never put the word in the context.
 *
 * This is a runtime guard, not a lint rule, because the failure mode is a
 * formatter interpolating a value into a template that happens to read
 * clinically. `assertNoBanTerms` runs on every formatter's return path and
 * throws — a tool call that fails loudly is recoverable; one that quietly
 * teaches the model to talk like a doctor is not.
 */

/**
 * Vocabulary that must never reach the model.
 *
 * Matching is prefix-based on word boundaries, so listing `desaturation`
 * also catches `desaturations` and `desaturating`. Inflections are still
 * listed explicitly where they read differently, for documentation value.
 */
export const BANNED_MEDICAL_VOCABULARY = [
  'desaturation',
  'desaturated',
  'desaturating',
  'hypoxia',
  'hypoxic',
  'hypoxemia',
  'apnea',
  'apneic',
  'arrhythmia',
  'arrhythmic',
  'bradycardia',
  'tachycardia',
  'ischemia',
  'ischemic',
] as const

export type BannedTerm = (typeof BANNED_MEDICAL_VOCABULARY)[number]

/**
 * What to write instead. Keys are the clinical phrasing a formatter author
 * might reach for; values are the register Ziva actually speaks.
 *
 * Ordered longest-first at use time so multi-word phrases win over their
 * constituent words.
 */
export const PREFERRED_LANGUAGE: Record<string, string> = {
  'oxygen desaturation': 'oxygen dip',
  'desaturation event': 'brief low moment',
  'desaturation events': 'brief low moments',
  'desaturations': 'brief low moments',
  'desaturation': 'brief low moment',
  'hypoxemia': 'low oxygen',
  'hypoxia': 'low oxygen',
  'apnea': 'pauses in breathing',
  'bradycardia': 'slow heart rate',
  'tachycardia': 'fast heart rate',
  'arrhythmia': 'irregular heartbeat',
}

/** Thrown when a formatter emits banned vocabulary. */
export class FormatterCopyError extends Error {
  readonly formatterName: string
  readonly found: string[]

  constructor(formatterName: string, found: string[]) {
    super(
      `Formatter '${formatterName}' emitted banned medical vocabulary: `
      + `${found.join(', ')}. Use PREFERRED_LANGUAGE or rewrite — this text `
      + `goes into an LLM's context and the model will repeat it.`,
    )
    this.name = 'FormatterCopyError'
    this.formatterName = formatterName
    this.found = found
  }
}

/**
 * Compiled matchers. Leading `\b` only: a trailing boundary would let
 * `desaturations` slip past a `desaturation` entry, and over-blocking is
 * the right bias for a guardrail on health copy.
 */
const MATCHERS: { term: string, re: RegExp }[] = BANNED_MEDICAL_VOCABULARY.map(
  term => ({ term, re: new RegExp(`\\b${term}`, 'iu') }),
)

/** Every banned term present in `text`, in list order. Empty when clean. */
export function findBanTerms(text: string): string[] {
  return MATCHERS.filter(m => m.re.test(text)).map(m => m.term)
}

/**
 * Guardrail called from every formatter's return path.
 *
 * @throws `FormatterCopyError` when any banned term appears.
 */
export function assertNoBanTerms(text: string, formatterName: string): void {
  const found = findBanTerms(text)
  if (found.length > 0) {
    throw new FormatterCopyError(formatterName, found)
  }
}

/**
 * Best-effort rewrite of clinical phrasing into Ziva's register.
 *
 * A convenience for formatter authors, NOT a substitute for the guard —
 * it only knows the phrases in `PREFERRED_LANGUAGE`, so
 * `assertNoBanTerms` still runs afterwards and still throws on anything
 * it missed.
 */
export function applyPreferredLanguage(text: string): string {
  // Longest first, so 'oxygen desaturation' is replaced before
  // 'desaturation' can consume half of it.
  const phrases = Object.keys(PREFERRED_LANGUAGE).sort((a, b) => b.length - a.length)
  let out = text
  for (const phrase of phrases) {
    out = out.replace(
      new RegExp(`\\b${phrase}\\b`, 'giu'),
      PREFERRED_LANGUAGE[phrase],
    )
  }
  return out
}
