/**
 * Where a user's settings live in the app's `KVStore`.
 *
 * The rules engine reads a `user_setting` target's threshold, and a
 * `phase_band` rule's scale, from `analytics:<userId>:<key>`. An app or pack
 * that writes those settings (a settings screen, a mutation, a test) builds
 * the key here rather than restating the prefix.
 */

/**
 * The `KVStore` key of setting `key` for `userId`:
 * `userSettingKey('u1', 'user:alertLevel')` → `'analytics:u1:user:alertLevel'`.
 */
export function userSettingKey(userId: string, key: string): string {
  return `analytics:${userId}:${key}`
}
