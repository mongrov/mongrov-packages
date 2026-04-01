export type ColorScheme = 'light' | 'dark' | 'system'

export interface ColorTokens {
  primary: string
  primaryForeground: string
  secondary: string
  secondaryForeground: string
  background: string
  foreground: string
  card: string
  cardForeground: string
  border: string
  input: string
  muted: string
  mutedForeground: string
  destructive: string
  destructiveForeground: string
  success: string
  successForeground: string
  warning: string
  warningForeground: string
  ring: string
}

export interface SpacingTokens {
  xs: number
  sm: number
  md: number
  lg: number
  xl: number
  '2xl': number
  '3xl': number
}

export interface TypographyTokens {
  fontFamily: {
    regular: string
    medium: string
    semibold: string
    bold: string
  }
  fontSize: {
    xs: number
    sm: number
    base: number
    lg: number
    xl: number
    '2xl': number
    '3xl': number
    '4xl': number
  }
  lineHeight: {
    tight: number
    normal: number
    relaxed: number
  }
}

export interface RadiiTokens {
  none: number
  sm: number
  md: number
  lg: number
  xl: number
  full: number
}

export interface ThemeTokens {
  colors: ColorTokens
  spacing: SpacingTokens
  typography: TypographyTokens
  radii: RadiiTokens
}

export interface ThemeContract {
  light: ThemeTokens
  dark: ThemeTokens
}

export interface ThemeConfig {
  /** Override default tokens per scheme */
  overrides?: {
    light?: DeepPartial<ThemeTokens>
    dark?: DeepPartial<ThemeTokens>
  }
  /** Initial color scheme preference. Default: 'system' */
  defaultColorScheme?: ColorScheme
  /** MMKV storage key for persisting preference. Default: '@mongrov/color-scheme' */
  storageKey?: string
}

/** Resolved theme — what useTheme() returns */
export interface Theme {
  tokens: ThemeTokens
  colorScheme: 'light' | 'dark'
  isDark: boolean
}

export type DeepPartial<T> = {
  [P in keyof T]?: T[P] extends object ? DeepPartial<T[P]> : T[P]
}
