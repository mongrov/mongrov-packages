import type { ThemeTokens } from '../types'
import { defaultDarkColors, defaultLightColors } from './colors'
import { defaultRadii } from './radii'
import { defaultSpacing } from './spacing'
import { defaultTypography } from './typography'

export const defaultLightTokens: ThemeTokens = {
  colors: defaultLightColors,
  spacing: defaultSpacing,
  typography: defaultTypography,
  radii: defaultRadii,
}

export const defaultDarkTokens: ThemeTokens = {
  colors: defaultDarkColors,
  spacing: defaultSpacing,
  typography: defaultTypography,
  radii: defaultRadii,
}
