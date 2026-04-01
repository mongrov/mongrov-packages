# @mongrov/theme

Theme contract and color scheme management for React Native / Expo apps.

Provides a `createTheme` factory, `ThemeProvider` context, and `useColorScheme` hook with persistent light/dark/system preference via Zustand + MMKV.

## Install

```bash
pnpm add @mongrov/theme
```

### Peer dependencies

```bash
pnpm add react react-native zustand react-native-mmkv
```

`react-native-mmkv` is optional — if unavailable, color scheme preference is stored in memory only.

## Quick Start

```tsx
import { createTheme, ThemeProvider, useTheme } from '@mongrov/theme'

// 1. Create theme with optional brand overrides
const appTheme = createTheme({
  overrides: {
    light: { colors: { primary: '#2563EB' } },
    dark: { colors: { primary: '#60A5FA' } },
  },
})

// 2. Wrap your app
export default function App() {
  return (
    <ThemeProvider theme={appTheme}>
      <MyScreen />
    </ThemeProvider>
  )
}

// 3. Use tokens in components
function MyScreen() {
  const { tokens, isDark } = useTheme()
  return (
    <View style={{ backgroundColor: tokens.colors.background }}>
      <Text style={{ color: tokens.colors.foreground }}>
        {isDark ? 'Dark mode' : 'Light mode'}
      </Text>
    </View>
  )
}
```

## Color Scheme

```tsx
import { useColorScheme } from '@mongrov/theme'

function Settings() {
  const { colorScheme, setColorScheme, isDark } = useColorScheme()

  return (
    <>
      <Button onPress={() => setColorScheme('light')} title="Light" />
      <Button onPress={() => setColorScheme('dark')} title="Dark" />
      <Button onPress={() => setColorScheme('system')} title="System" />
    </>
  )
}
```

Preference is persisted to MMKV and restored on next app launch.

## API

### `createTheme(config?)`

Creates a `ThemeContract` with light and dark token sets. Overrides are deep-merged onto defaults.

### `<ThemeProvider theme={...} config?>`

Provides resolved theme via React context. Resolves `system` preference using `Appearance.getColorScheme()`.

### `useTheme()`

Returns `{ tokens, colorScheme, isDark }`. Must be used within `ThemeProvider`.

### `useColorScheme()`

Returns `{ colorScheme, resolvedScheme, setColorScheme, isDark }`. Must be used within `ThemeProvider`.

### `defaultLightTokens` / `defaultDarkTokens`

Exported default token sets for reference or extension.

## Token Structure

```
ThemeTokens = {
  colors:     ColorTokens      (19 semantic keys)
  spacing:    SpacingTokens     (xs → 3xl)
  typography: TypographyTokens  (fontFamily, fontSize, lineHeight)
  radii:      RadiiTokens       (none → full)
}
```

## License

MIT
