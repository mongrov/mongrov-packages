import { afterEach, describe, expect, it } from 'vitest'
import { shouldStartMcpServer } from '../guard'

const originalDev = (globalThis as Record<string, unknown>).__DEV__
const originalFlag = process.env.ENABLE_MCP_SERVER

function restoreGlobals() {
  if (originalDev === undefined) {
    delete (globalThis as Record<string, unknown>).__DEV__
  }
  else {
    ;(globalThis as Record<string, unknown>).__DEV__ = originalDev
  }
  if (originalFlag === undefined) {
    delete process.env.ENABLE_MCP_SERVER
  }
  else {
    process.env.ENABLE_MCP_SERVER = originalFlag
  }
}

describe('shouldStartMcpServer', () => {
  afterEach(() => {
    restoreGlobals()
  })

  it('returns true when __DEV__ is true', () => {
    (globalThis as Record<string, unknown>).__DEV__ = true
    delete process.env.ENABLE_MCP_SERVER
    expect(shouldStartMcpServer()).toBe(true)
  })

  it('returns true when ENABLE_MCP_SERVER=1', () => {
    delete (globalThis as Record<string, unknown>).__DEV__
    process.env.ENABLE_MCP_SERVER = '1'
    expect(shouldStartMcpServer()).toBe(true)
  })

  it('returns false when __DEV__ is false and env unset', () => {
    (globalThis as Record<string, unknown>).__DEV__ = false
    delete process.env.ENABLE_MCP_SERVER
    expect(shouldStartMcpServer()).toBe(false)
  })

  it('returns false when both are unset', () => {
    delete (globalThis as Record<string, unknown>).__DEV__
    delete process.env.ENABLE_MCP_SERVER
    expect(shouldStartMcpServer()).toBe(false)
  })

  it('ignores env values other than "1"', () => {
    delete (globalThis as Record<string, unknown>).__DEV__
    process.env.ENABLE_MCP_SERVER = 'true'
    expect(shouldStartMcpServer()).toBe(false)
    process.env.ENABLE_MCP_SERVER = 'yes'
    expect(shouldStartMcpServer()).toBe(false)
  })
})
