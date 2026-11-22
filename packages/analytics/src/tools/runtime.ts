/**
 * @internal Where the framework is running, for the two choices that differ
 * between a test run and a shipped build: `defineTool`'s lint, and whether an
 * output that fails validation throws (tests) or becomes an `output_invalid`
 * result (everywhere else).
 */

declare const process: { env?: Record<string, string | undefined> } | undefined

/** True under vitest or jest (or `NODE_ENV=test`). */
export function isTestRuntime(): boolean {
  if (typeof process === 'undefined' || !process.env)
    return false
  const env = process.env
  return env.VITEST !== undefined || env.JEST_WORKER_ID !== undefined || env.NODE_ENV === 'test'
}
