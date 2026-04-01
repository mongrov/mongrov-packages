import React from 'react';
import { Pressable, ScrollView, Text, View } from 'react-native';
import type { QuickReplyBarProps } from '../types';

export function QuickReplyBar({
  replies,
  onSelect,
  testID,
}: QuickReplyBarProps) {
  if (!replies || replies.length === 0) {
    return null;
  }

  return (
    <View className="border-t border-border bg-background py-2" testID={testID}>
      <ScrollView
        horizontal
        showsHorizontalScrollIndicator={false}
        contentContainerStyle={{ paddingHorizontal: 12, gap: 8 }}
      >
        {replies.map((reply, index) => (
          <Pressable
            key={`${reply}-${index}`}
            onPress={() => onSelect(reply)}
            className="rounded-full border border-border bg-muted px-4 py-2"
            testID={testID ? `${testID}-${index}` : undefined}
          >
            <Text className="text-sm text-foreground">{reply}</Text>
          </Pressable>
        ))}
      </ScrollView>
    </View>
  );
}
