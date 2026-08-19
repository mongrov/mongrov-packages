/**
 * `@mongrov/vitals-hooks/mock` — types-and-mock milestone.
 *
 * Deliberately a separate entry point from the package root: a screen importing
 * from `@mongrov/vitals-hooks` gets the real hooks (once they exist), and one
 * importing from `/mock` has said so out loud. There is no flag that silently
 * swaps them.
 */
export * from './fixtures'
export * from './provider'
