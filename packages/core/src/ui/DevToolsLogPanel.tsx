import React, { useEffect } from 'react';
import { Text, View } from 'react-native';
import { LogExportButton } from './LogExportButton';
import { LogFilterBar } from './LogFilterBar';
import { LogViewer } from './LogViewer';
import type { DevToolsLogPanelProps } from './types';
import { useLogViewer } from './useLogViewer';

export function DevToolsLogPanel({
  title = 'Dev Tools',
  testID,
}: DevToolsLogPanelProps) {
  const { entries, filter, refresh, setLevelFilter, exportLogs } =
    useLogViewer();

  useEffect(() => {
    refresh();
  }, [refresh]);

  return (
    <View className="flex-1" testID={testID}>
      <View className="flex-row items-center justify-between px-4 py-2">
        <Text className="text-xl font-bold text-neutral-900 dark:text-neutral-100">{title}</Text>
        <LogExportButton
          getExportData={exportLogs}
          testID={testID ? `${testID}-export` : undefined}
        />
      </View>

      <LogFilterBar
        activeLevel={filter.level}
        onSelectLevel={(level) => {
          setLevelFilter(level);
          setTimeout(refresh, 0);
        }}
        testID={testID ? `${testID}-filter` : undefined}
      />

      <Text className="px-4 py-1 text-xs text-neutral-500 dark:text-neutral-400">
        {entries.length} entries
      </Text>

      <LogViewer
        entries={entries}
        testID={testID ? `${testID}-viewer` : undefined}
      />
    </View>
  );
}
