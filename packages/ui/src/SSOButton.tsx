import * as React from 'react';
import { ActivityIndicator, Platform, Pressable, View, Text } from 'react-native';

import { cn } from './primitives/utils';

export interface SSOButtonProps {
  onPress: () => void;
  loading?: boolean;
  disabled?: boolean;
  /** Button label. Default: "Enterprise Sign-In" */
  label?: string;
  /** Provider name to display (e.g., "Okta", "Azure AD"). Overrides label. */
  providerName?: string;
  className?: string;
  /** Test ID for testing */
  testID?: string;
}

/**
 * Enterprise SSO button with outline style.
 * Used for OIDC/SAML authentication with Okta, Azure AD, etc.
 */
export function SSOButton({
  onPress,
  loading = false,
  disabled = false,
  label = 'Enterprise Sign-In',
  providerName,
  className,
  testID,
}: SSOButtonProps) {
  const displayLabel = providerName ? `Sign in with ${providerName}` : label;
  const isDisabled = disabled || loading;

  return (
    <Pressable
      testID={testID}
      onPress={onPress}
      disabled={isDisabled}
      className={cn(
        'h-12 flex-row items-center justify-center rounded-lg border border-neutral-300 bg-white px-4 dark:border-neutral-600 dark:bg-neutral-900',
        isDisabled && 'opacity-50',
        Platform.select({
          web: 'transition-all hover:bg-neutral-50 focus:outline-none focus:ring-2 focus:ring-primary-500 focus:ring-offset-2 dark:hover:bg-neutral-800',
        }),
        className
      )}
      role="button"
      accessibilityLabel={displayLabel}
    >
      {loading ? (
        <ActivityIndicator
          size="small"
          className="text-neutral-900 dark:text-neutral-100"
        />
      ) : (
        <View className="flex-row items-center gap-3">
          {/* Lock/building icon placeholder */}
          <Text className="text-lg text-neutral-600 dark:text-neutral-400">🔐</Text>
          <Text className="text-base font-semibold text-neutral-900 dark:text-neutral-100">
            {displayLabel}
          </Text>
        </View>
      )}
    </Pressable>
  );
}
