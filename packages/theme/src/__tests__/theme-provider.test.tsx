/**
 * @jest-environment jsdom
 */
import React from 'react'
import { renderHook } from '@testing-library/react'
import { createTheme } from '../create-theme'
import { ThemeProvider, useTheme, useColorScheme } from '../theme-provider'
import { defaultLightTokens } from '../tokens'
import { Appearance } from 'react-native'

const mockGetColorScheme = Appearance.getColorScheme as jest.Mock

beforeEach(() => {
  mockGetColorScheme.mockReturnValue('light')
})

const testTheme = createTheme()

function wrapper({ children }: { children: React.ReactNode }) {
  return <ThemeProvider theme={testTheme}>{children}</ThemeProvider>
}

describe('ThemeProvider', () => {
  it('should render children', () => {
    const { result } = renderHook(() => useTheme(), { wrapper })
    expect(result.current).toBeDefined()
  })

  it('should provide light tokens by default (system=light)', () => {
    const { result } = renderHook(() => useTheme(), { wrapper })
    expect(result.current.tokens).toEqual(defaultLightTokens)
    expect(result.current.colorScheme).toBe('light')
    expect(result.current.isDark).toBe(false)
  })

  it('should provide dark tokens when system is dark', () => {
    mockGetColorScheme.mockReturnValue('dark')
    function darkWrapper({ children }: { children: React.ReactNode }) {
      return <ThemeProvider theme={testTheme}>{children}</ThemeProvider>
    }
    const { result } = renderHook(() => useTheme(), { wrapper: darkWrapper })
    expect(result.current.colorScheme).toBe('dark')
    expect(result.current.isDark).toBe(true)
  })

  it('should expose useColorScheme with correct shape', () => {
    const { result } = renderHook(() => useColorScheme(), { wrapper })
    expect(result.current).toHaveProperty('colorScheme')
    expect(result.current).toHaveProperty('resolvedScheme')
    expect(result.current).toHaveProperty('setColorScheme')
    expect(result.current).toHaveProperty('isDark')
    expect(typeof result.current.setColorScheme).toBe('function')
  })
})

describe('useTheme outside provider', () => {
  it('should throw when used outside ThemeProvider', () => {
    // Suppress console.error for the expected error
    const spy = jest.spyOn(console, 'error').mockImplementation(() => {})
    expect(() => {
      renderHook(() => useTheme())
    }).toThrow('useTheme must be used within a ThemeProvider')
    spy.mockRestore()
  })
})
