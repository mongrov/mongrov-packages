import type { DeepPartial, ThemeConfig, ThemeContract, ThemeTokens } from './types'
import { defaultDarkTokens, defaultLightTokens } from './tokens'

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function deepMerge(
  base: Record<string, unknown>,
  overrides: Record<string, unknown>,
): Record<string, unknown> {
  const result: Record<string, unknown> = { ...base }
  for (const key of Object.keys(overrides)) {
    const baseVal = base[key]
    const overrideVal = overrides[key]
    if (isPlainObject(baseVal) && isPlainObject(overrideVal)) {
      result[key] = deepMerge(baseVal, overrideVal)
    } else if (overrideVal !== undefined) {
      result[key] = overrideVal
    }
  }
  return result
}

function mergeTokens(
  defaults: ThemeTokens,
  overrides: DeepPartial<ThemeTokens>,
): ThemeTokens {
  return deepMerge(
    defaults as unknown as Record<string, unknown>,
    overrides as unknown as Record<string, unknown>,
  ) as unknown as ThemeTokens
}

export function createTheme(config?: ThemeConfig): ThemeContract {
  const lightOverrides = config?.overrides?.light
  const darkOverrides = config?.overrides?.dark

  return {
    light: lightOverrides
      ? mergeTokens(defaultLightTokens, lightOverrides)
      : defaultLightTokens,
    dark: darkOverrides
      ? mergeTokens(defaultDarkTokens, darkOverrides)
      : defaultDarkTokens,
  }
}
