import { Appearance } from 'react-native'
import { createColorSchemeStore } from '../color-scheme-store'
import { createUseColorScheme, resolveScheme } from '../color-scheme'

// We test resolveScheme directly (non-hook) and the factory for hook creation

const mockGetColorScheme = Appearance.getColorScheme as jest.Mock

beforeEach(() => {
  mockGetColorScheme.mockReturnValue('light')
})

describe('resolveScheme', () => {
  it('should return light when preference is light', () => {
    expect(resolveScheme('light')).toBe('light')
  })

  it('should return dark when preference is dark', () => {
    expect(resolveScheme('dark')).toBe('dark')
  })

  it('should resolve system to Appearance value', () => {
    mockGetColorScheme.mockReturnValue('dark')
    expect(resolveScheme('system')).toBe('dark')
  })

  it('should fall back to light when Appearance returns null', () => {
    mockGetColorScheme.mockReturnValue(null)
    expect(resolveScheme('system')).toBe('light')
  })
})

describe('createUseColorScheme', () => {
  it('should create a hook factory from a store', () => {
    const store = createColorSchemeStore()
    const useColorScheme = createUseColorScheme(store)
    expect(typeof useColorScheme).toBe('function')
  })
})
