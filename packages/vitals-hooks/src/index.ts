/**
 * `@mongrov/vitals-hooks` — the view-model layer the vital screens consume.
 *
 * MILESTONE: types + mock provider. The real hooks are not here yet.
 *
 * What exists:
 *   - `./types` — the UX Interface Contract v1.4 as types. These ARE the
 *     contract; a screen that compiles against them renders the fields the
 *     contract names.
 *   - `@mongrov/vitals-hooks/mock` — `MockVitalsProvider` plus the hook
 *     signatures, so screens can be built and reviewed against all five
 *     status states before the query wiring lands.
 *
 * What does not:
 *   - the real `useSpO2Day` / `useSpO2Trend` / … over `@mongrov/data-access`.
 *     Importing them from the root is a compile error rather than a silent
 *     fallback to mock data, which is the point of the split entry.
 */
export * from './map/marks'
export * from './status'
export * from './types'
