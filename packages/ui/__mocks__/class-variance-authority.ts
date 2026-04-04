// Mock for class-variance-authority

export function cva(base: string, config?: { variants?: Record<string, Record<string, string>>; defaultVariants?: Record<string, string> }) {
  return function(props?: Record<string, string>) {
    const classes = [base]
    const mergedProps = { ...config?.defaultVariants, ...props }

    if (config?.variants && mergedProps) {
      for (const [key, value] of Object.entries(mergedProps)) {
        if (value && config.variants[key]?.[value]) {
          classes.push(config.variants[key][value])
        }
      }
    }
    return classes.join(' ')
  }
}

export type { VariantProps } from 'class-variance-authority'
