// Mock for @rn-primitives/slot
import React from 'react'

export const Text = ({ children, testID, className, ...props }: any) =>
  React.createElement('span', { 'data-testid': testID, className, ...props }, children)
