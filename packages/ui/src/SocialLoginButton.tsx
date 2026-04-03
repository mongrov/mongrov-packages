import * as React from 'react';
import { ActivityIndicator, Platform, Pressable, View, Text } from 'react-native';

import { cn } from './primitives/utils';

export type SocialProvider = 'apple' | 'google' | 'github';

export interface SocialLoginButtonProps {
  provider: SocialProvider;
  onPress: () => void;
  loading?: boolean;
  disabled?: boolean;
  label?: string;
  className?: string;
  /** Test ID for testing */
  testID?: string;
}

const providerConfig: Record<SocialProvider, { label: string; icon: string; bgClass: string; textClass: string }> = {
  apple: {
    label: 'Continue with Apple',
    icon: '',
    bgClass: 'bg-black dark:bg-white',
    textClass: 'text-white dark:text-black',
  },
  google: {
    label: 'Continue with Google',
    icon: 'G',
    bgClass: 'bg-white dark:bg-neutral-800 border border-neutral-300 dark:border-neutral-600',
    textClass: 'text-neutral-900 dark:text-neutral-100',
  },
  github: {
    label: 'Continue with GitHub',
    icon: '',
    bgClass: 'bg-neutral-900 dark:bg-white',
    textClass: 'text-white dark:text-black',
  },
};

/**
 * Branded social login button for Apple, Google, or GitHub.
 * Uses platform-appropriate styling and colors.
 */
export function SocialLoginButton({
  provider,
  onPress,
  loading = false,
  disabled = false,
  label,
  className,
  testID,
}: SocialLoginButtonProps) {
  const config = providerConfig[provider];
  const displayLabel = label ?? config.label;
  const isDisabled = disabled || loading;

  return (
    <Pressable
      testID={testID}
      onPress={onPress}
      disabled={isDisabled}
      className={cn(
        'h-12 flex-row items-center justify-center rounded-lg px-4',
        config.bgClass,
        isDisabled && 'opacity-50',
        Platform.select({
          web: 'transition-opacity hover:opacity-90 focus:outline-none focus:ring-2 focus:ring-primary-500 focus:ring-offset-2',
        }),
        className
      )}
      role="button"
      accessibilityLabel={displayLabel}
    >
      {loading ? (
        <ActivityIndicator
          size="small"
          className={config.textClass}
        />
      ) : (
        <View className="flex-row items-center gap-3">
          {/* Icon placeholder - apps can customize with actual icons */}
          {provider === 'apple' && (
            <Text className={cn('text-lg font-bold', config.textClass)}></Text>
          )}
          {provider === 'google' && (
            <View className="h-5 w-5 items-center justify-center rounded-sm bg-white">
              <Text className="text-sm font-bold text-neutral-700">G</Text>
            </View>
          )}
          {provider === 'github' && (
            <Text className={cn('text-lg font-bold', config.textClass)}></Text>
          )}
          <Text className={cn('text-base font-semibold', config.textClass)}>
            {displayLabel}
          </Text>
        </View>
      )}
    </Pressable>
  );
}
