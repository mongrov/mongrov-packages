// Mock for @rn-primitives/separator
import * as React from 'react'

export function Root({ children, testID, className, orientation, decorative, ...props }: any) {
  return React.createElement('hr', { 'data-testid': testID, className, 'data-orientation': orientation, ...props }, children)
}
