/**
 * Formatter surface for `@mongrov/analytics/tools`.
 *
 * Two concerns, kept separate:
 *
 * - `text.ts` — mechanical string/number helpers (byte counts, deltas).
 * - `copy-guidelines.ts` — the user-language guardrail (principle 37).
 *   Every formatter calls `assertNoBanTerms` on its return path.
 *
 * Re-exported here so call sites keep importing from `'../formatters'`.
 */

export {
  applyPreferredLanguage,
  assertNoBanTerms,
  BANNED_MEDICAL_VOCABULARY,
  type BannedTerm,
  findBanTerms,
  FormatterCopyError,
  PREFERRED_LANGUAGE,
} from './copy-guidelines'
export { deltaPct, formatBytes, popStddev } from './text'
