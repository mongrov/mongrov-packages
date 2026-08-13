// Mock for @rn-primitives/slot
import * as React from 'react'

export function Text({ children, testID, className, ...props }: any) {
  return React.createElement('span', { 'data-testid': testID, className, ...props }, children)
}
