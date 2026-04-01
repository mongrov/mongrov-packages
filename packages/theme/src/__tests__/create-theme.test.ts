import { createTheme } from '../create-theme'
import { defaultDarkTokens, defaultLightTokens } from '../tokens'

describe('createTheme', () => {
  it('should return defaults when called with no config', () => {
    const theme = createTheme()
    expect(theme.light).toEqual(defaultLightTokens)
    expect(theme.dark).toEqual(defaultDarkTokens)
  })

  it('should return defaults when called with empty overrides', () => {
    const theme = createTheme({ overrides: {} })
    expect(theme.light).toEqual(defaultLightTokens)
    expect(theme.dark).toEqual(defaultDarkTokens)
  })

  it('should merge partial light color overrides', () => {
    const theme = createTheme({
      overrides: {
        light: {
          colors: { primary: '#FF0000' },
        },
      },
    })
    expect(theme.light.colors.primary).toBe('#FF0000')
    // Other colors should remain default
    expect(theme.light.colors.background).toBe(defaultLightTokens.colors.background)
    // Dark should be unaffected
    expect(theme.dark.colors.primary).toBe(defaultDarkTokens.colors.primary)
  })

  it('should merge partial dark color overrides', () => {
    const theme = createTheme({
      overrides: {
        dark: {
          colors: { background: '#000000', foreground: '#FFFFFF' },
        },
      },
    })
    expect(theme.dark.colors.background).toBe('#000000')
    expect(theme.dark.colors.foreground).toBe('#FFFFFF')
    expect(theme.dark.colors.primary).toBe(defaultDarkTokens.colors.primary)
    // Light should be unaffected
    expect(theme.light.colors.background).toBe(defaultLightTokens.colors.background)
  })

  it('should merge both light and dark independently', () => {
    const theme = createTheme({
      overrides: {
        light: { colors: { primary: '#111111' } },
        dark: { colors: { primary: '#EEEEEE' } },
      },
    })
    expect(theme.light.colors.primary).toBe('#111111')
    expect(theme.dark.colors.primary).toBe('#EEEEEE')
  })

  it('should deep merge nested typography overrides', () => {
    const theme = createTheme({
      overrides: {
        light: {
          typography: {
            fontFamily: { regular: 'CustomFont' },
          },
        },
      },
    })
    expect(theme.light.typography.fontFamily.regular).toBe('CustomFont')
    // Other font families remain default
    expect(theme.light.typography.fontFamily.bold).toBe(
      defaultLightTokens.typography.fontFamily.bold,
    )
    // Other typography sections remain default
    expect(theme.light.typography.fontSize).toEqual(defaultLightTokens.typography.fontSize)
  })

  it('should merge spacing overrides', () => {
    const theme = createTheme({
      overrides: {
        light: { spacing: { xs: 2, sm: 4 } },
      },
    })
    expect(theme.light.spacing.xs).toBe(2)
    expect(theme.light.spacing.sm).toBe(4)
    expect(theme.light.spacing.md).toBe(defaultLightTokens.spacing.md)
  })

  it('should merge radii overrides', () => {
    const theme = createTheme({
      overrides: {
        dark: { radii: { lg: 20 } },
      },
    })
    expect(theme.dark.radii.lg).toBe(20)
    expect(theme.dark.radii.sm).toBe(defaultDarkTokens.radii.sm)
  })
})
