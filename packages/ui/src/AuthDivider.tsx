import * as React from 'react';
import { View, Text } from 'react-native';

import { cn } from './primitives/utils';

export interface AuthDividerProps {
  /** Text to display in the divider. Default: "or continue with" */
  text?: string;
  className?: string;
}

/**
 * Horizontal divider with centered text, typically used between auth methods.
 * Example: email/password form ---or continue with--- social buttons
 */
export function AuthDivider({
  text = 'or continue with',
  className,
}: AuthDividerProps) {
  return (
    <View className={cn('flex-row items-center my-6', className)}>
      <View className="flex-1 h-px bg-neutral-200 dark:bg-neutral-700" />
      <Text className="mx-4 text-sm text-neutral-500 dark:text-neutral-400">
        {text}
      </Text>
      <View className="flex-1 h-px bg-neutral-200 dark:bg-neutral-700" />
    </View>
  );
}
