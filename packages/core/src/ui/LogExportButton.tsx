import React from 'react';
import { Pressable, Share, Text } from 'react-native';
import type { LogExportButtonProps } from './types';

export function LogExportButton({
  getExportData,
  label = 'Export Logs',
  testID,
}: LogExportButtonProps) {
  const handleExport = async () => {
    const data = getExportData();
    try {
      await Share.share({
        message: data,
        title: 'App Logs',
      });
    } catch {
      // Share cancelled or failed
    }
  };

  return (
    <Pressable
      onPress={handleExport}
      className="rounded-lg bg-primary px-4 py-2"
      testID={testID}
    >
      <Text className="text-sm font-medium text-primary-foreground">
        {label}
      </Text>
    </Pressable>
  );
}
