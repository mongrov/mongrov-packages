import React from 'react';
import { Text, View } from 'react-native';

export interface ChatEmptyStateProps {
  title?: string;
  subtitle?: string;
  testID?: string;
}

export function ChatEmptyState({
  title = 'Start a conversation',
  subtitle = 'Send a message to begin chatting with AI',
  testID,
}: ChatEmptyStateProps) {
  return (
    <View
      className="flex-1 items-center justify-center p-8"
      testID={testID}
    >
      <Text className="text-center text-lg font-semibold text-foreground">
        {title}
      </Text>
      <Text className="mt-2 text-center text-sm text-muted-foreground">
        {subtitle}
      </Text>
    </View>
  );
}
