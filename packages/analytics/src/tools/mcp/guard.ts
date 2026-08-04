/**
 * MCP gating — advisory flag + enforced production guard.
 *
 * `shouldStartMcpServer()` is the *advisory* cross-runtime dev flag:
 * `true` iff the process is a React Native dev build (`__DEV__ === true`)
 * **or** the Node process has `ENABLE_MCP_SERVER=1` set. Prod RN builds
 * have `__DEV__ === false` and no `process.env`, so the check returns
 * `false` and the caller short-circuits — with `sideEffects: false` at
 * the package root, this lets bundlers drop every module reachable only
 * through the MCP subpath (including `@modelcontextprotocol/sdk`).
 *
 * `assertMcpAllowed()` is the *enforced* production runtime guard
 * (principle 41): it THROWS `McpDisabledError` unless `__DEV__` is truthy
 * **and** `ENABLE_MCP_SERVER=1` is set — dev signal AND explicit opt-in,
 * not either/or. Every entry point that can start a transport
 * (`createMcpServer`, `createHttpTransport`) calls it; the advisory flag
 * alone never gates anything at runtime.
 *
 * Both helpers are intentionally pure — importing this module does not
 * itself import the SDK. Callers should still gate SDK imports behind
 * `shouldStartMcpServer()` at their entry point for tree-shaking.
 */

declare const __DEV__: boolean | undefined

function isRnDev(): boolean {
  return typeof __DEV__ !== 'undefined' && __DEV__ === true
}

function isMcpFlagSet(): boolean {
  return typeof process !== 'undefined'
    && process.env?.ENABLE_MCP_SERVER === '1'
}

export function shouldStartMcpServer(): boolean {
  return isRnDev() || isMcpFlagSet()
}

/** Thrown by `assertMcpAllowed()` when the MCP surface is disabled. */
export class McpDisabledError extends Error {
  constructor() {
    super(
      'MCP server is disabled: requires a dev build (__DEV__ === true) '
      + 'AND ENABLE_MCP_SERVER=1 (principle 41 — MCP is dev-only). '
      + 'Refusing to start a transport in a production runtime.',
    )
    this.name = 'McpDisabledError'
  }
}

/**
 * Enforced production guard (principle 41): throw unless
 * `__DEV__ && ENABLE_MCP_SERVER`. Called by every transport-capable
 * entry point in this subpath.
 */
export function assertMcpAllowed(): void {
  if (!(isRnDev() && isMcpFlagSet())) {
    throw new McpDisabledError()
  }
}
