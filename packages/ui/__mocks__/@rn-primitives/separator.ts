// Mock for @rn-primitives/separator
import React from 'react'

export const Root = ({ children, testID, className, orientation, decorative, ...props }: any) =>
  React.createElement('hr', { 'data-testid': testID, className, 'data-orientation': orientation, ...props }, children)
