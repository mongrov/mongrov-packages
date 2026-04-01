import React from 'react';
import { FlatList, View } from 'react-native';
import { LogEntryRow } from './LogEntryRow';
import type { LogViewerProps } from './types';

export function LogViewer({ entries, testID }: LogViewerProps) {
  return (
    <View className="flex-1" testID={testID}>
      <FlatList
        data={entries}
        renderItem={({ item }) => <LogEntryRow entry={item} />}
        keyExtractor={(item) => item.id}
      />
    </View>
  );
}
