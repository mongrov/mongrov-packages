import type { StatusBadgeProps, StatusBadgeVariant } from './types'
import * as React from 'react'
import { Text, View } from 'react-native'

const variantStyles: Record<StatusBadgeVariant, { container: string, text: string }> = {
  default: {
    container: 'bg-muted',
    text: 'text-muted-foreground',
  },
  success: {
    container: 'bg-success',
    text: 'text-success-foreground',
  },
  error: {
    container: 'bg-destructive',
    text: 'text-destructive-foreground',
  },
  warning: {
    container: 'bg-warning',
    text: 'text-warning-foreground',
  },
}

export function StatusBadge({ label, variant = 'default', testID }: StatusBadgeProps) {
  const styles = variantStyles[variant]

  return (
    <View className={`rounded-full px-3 py-1 ${styles.container}`} testID={testID}>
      <Text className={`text-xs font-medium ${styles.text}`}>{label}</Text>
    </View>
  )
}
