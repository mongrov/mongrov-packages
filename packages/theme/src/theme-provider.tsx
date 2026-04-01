import { createContext, useContext, useMemo } from 'react'
import type { Theme, ThemeConfig, ThemeContract } from './types'
import { createColorSchemeStore } from './color-scheme-store'
import { createUseColorScheme, resolveScheme } from './color-scheme'

const ThemeContext = createContext<Theme | null>(null)

let sharedStore: ReturnType<typeof createColorSchemeStore> | null = null
let sharedUseColorScheme: ReturnType<typeof createUseColorScheme> | null = null

export function ThemeProvider(props: {
  theme: ThemeContract
  config?: ThemeConfig
  children: React.ReactNode
}) {
  const { theme, config, children } = props

  // Create store once per provider mount
  const store = useMemo(() => {
    const s = createColorSchemeStore({
      defaultColorScheme: config?.defaultColorScheme,
      storageKey: config?.storageKey,
    })
    sharedStore = s
    sharedUseColorScheme = createUseColorScheme(s)
    return s
  }, [config?.defaultColorScheme, config?.storageKey])

  // Resolve the current scheme reactively
  const hookResult = sharedUseColorScheme!()

  const value = useMemo<Theme>(() => ({
    tokens: hookResult.resolvedScheme === 'dark' ? theme.dark : theme.light,
    colorScheme: hookResult.resolvedScheme,
    isDark: hookResult.isDark,
  }), [theme, hookResult.resolvedScheme, hookResult.isDark])

  return (
    <ThemeContext.Provider value={value}>
      {children}
    </ThemeContext.Provider>
  )
}

export function useTheme(): Theme {
  const theme = useContext(ThemeContext)
  if (!theme) {
    throw new Error('useTheme must be used within a ThemeProvider')
  }
  return theme
}

export function useColorScheme() {
  if (!sharedUseColorScheme) {
    throw new Error('useColorScheme must be used within a ThemeProvider')
  }
  return sharedUseColorScheme()
}
