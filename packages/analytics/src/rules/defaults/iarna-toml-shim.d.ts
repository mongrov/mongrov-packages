/**
 * Type shim for the sub-path import used by loader.ts.
 *
 * @iarna/toml ships types only for the main module; we import
 * parse-string.js directly to avoid the parse-stream.js -> require('stream')
 * chain that Metro cannot resolve in React Native.
 */
declare module '@iarna/toml/parse-string.js' {
  const parseString: (toml: string) => Record<string, unknown>
  export default parseString
}
