// Mock for react-native-reanimated
import React from 'react'

const Animated = {
  View: ({ children, style, testID, className, ...props }: any) =>
    React.createElement('div', { style, 'data-testid': testID, className, ...props }, children),
}

export default Animated

export function useSharedValue(initialValue: number) {
  return { value: initialValue }
}

export function useAnimatedStyle(styleFactory: () => object) {
  return styleFactory()
}

export function withRepeat(animation: any, numberOfReps?: number, reverse?: boolean) {
  return animation
}

export function withTiming(toValue: number, config?: { duration?: number }) {
  return toValue
}
