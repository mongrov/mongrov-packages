/**
 * `shouldStartMcpServer` — cross-runtime dev flag for the MCP subpath.
 *
 * Returns `true` iff the process is a React Native dev build
 * (`__DEV__ === true`) **or** the Node process has
 * `ENABLE_MCP_SERVER=1` set. Prod RN builds have `__DEV__ === false`
 * and no `process.env`, so the check returns `false` and the caller
 * short-circuits — with `sideEffects: false` at the package root,
 * this lets bundlers drop every module reachable only through the
 * MCP subpath (including `@modelcontextprotocol/sdk`).
 *
 * The helper is intentionally pure — importing it does not itself
 * import the SDK. Callers should gate SDK imports behind
 * `shouldStartMcpServer()` at their entry point.
 */

declare const __DEV__: boolean | undefined

export function shouldStartMcpServer(): boolean {
  const isRnDev
    = typeof __DEV__ !== 'undefined' && __DEV__ === true
  const isNodeFlag
    = typeof process !== 'undefined'
      && process.env?.ENABLE_MCP_SERVER === '1'
  return isRnDev || isNodeFlag
}
