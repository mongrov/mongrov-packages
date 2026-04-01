import { useEffect, useState } from 'react'
import { Appearance } from 'react-native'
import { useStore } from 'zustand'
import type { StoreApi } from 'zustand/vanilla'
import type { ColorScheme } from './types'

interface ColorSchemeState {
  colorScheme: ColorScheme
  setColorScheme: (scheme: ColorScheme) => void
}

function resolveScheme(preference: ColorScheme): 'light' | 'dark' {
  if (preference === 'system') {
    return Appearance.getColorScheme() ?? 'light'
  }
  return preference
}

export function createUseColorScheme(store: StoreApi<ColorSchemeState>) {
  return function useColorScheme() {
    const colorScheme = useStore(store, (s) => s.colorScheme)
    const setColorScheme = useStore(store, (s) => s.setColorScheme)
    const [systemScheme, setSystemScheme] = useState<'light' | 'dark'>(
      () => Appearance.getColorScheme() ?? 'light',
    )

    useEffect(() => {
      if (colorScheme !== 'system') return

      const subscription = Appearance.addChangeListener(({ colorScheme: newScheme }) => {
        setSystemScheme(newScheme ?? 'light')
      })
      return () => subscription.remove()
    }, [colorScheme])

    const resolvedScheme: 'light' | 'dark' =
      colorScheme === 'system' ? systemScheme : colorScheme

    return {
      colorScheme,
      resolvedScheme,
      setColorScheme,
      isDark: resolvedScheme === 'dark',
    }
  }
}

// Non-hook utility for resolving outside React
export { resolveScheme }
