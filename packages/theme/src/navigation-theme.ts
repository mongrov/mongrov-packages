import { useTheme } from './theme-provider'

/**
 * Bridge @mongrov/theme tokens to @react-navigation/native Theme shape.
 *
 * Usage:
 * ```tsx
 * import { useNavigationTheme } from '@mongrov/theme/navigation';
 * import { ThemeProvider } from '@react-navigation/native';
 *
 * const navTheme = useNavigationTheme();
 * <ThemeProvider value={navTheme}>…</ThemeProvider>
 * ```
 *
 * Requires `@react-navigation/native` as a peer dependency.
 * The Theme type is inlined to avoid a hard dependency on the package at build time.
 */

interface NavigationFonts {
  fontFamily: string
  fontWeight:
    | 'normal'
    | 'bold'
    | '100'
    | '200'
    | '300'
    | '400'
    | '500'
    | '600'
    | '700'
    | '800'
    | '900'
}

interface NavigationTheme {
  dark: boolean
  colors: {
    primary: string
    background: string
    card: string
    text: string
    border: string
    notification: string
  }
  fonts: {
    regular: NavigationFonts
    medium: NavigationFonts
    bold: NavigationFonts
    heavy: NavigationFonts
  }
}

export function useNavigationTheme(): NavigationTheme {
  const { tokens, isDark } = useTheme()

  return {
    dark: isDark,
    colors: {
      primary: tokens.colors.primary,
      background: tokens.colors.background,
      card: tokens.colors.card,
      text: tokens.colors.foreground,
      border: tokens.colors.border,
      notification: tokens.colors.destructive,
    },
    fonts: {
      regular: {
        fontFamily: tokens.typography.fontFamily.regular,
        fontWeight: '400',
      },
      medium: {
        fontFamily: tokens.typography.fontFamily.medium,
        fontWeight: '500',
      },
      bold: {
        fontFamily: tokens.typography.fontFamily.bold,
        fontWeight: '700',
      },
      heavy: {
        fontFamily: tokens.typography.fontFamily.bold,
        fontWeight: '900',
      },
    },
  }
}
