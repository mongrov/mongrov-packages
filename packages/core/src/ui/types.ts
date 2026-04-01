import type { LogEntry, LogFilter, LogLevel } from '../types';

export interface LogEntryRowProps {
  entry: LogEntry;
  testID?: string;
}

export interface LogFilterBarProps {
  activeLevel: LogLevel | undefined;
  onSelectLevel: (level: LogLevel | undefined) => void;
  testID?: string;
}

export interface LogExportButtonProps {
  getExportData: () => string;
  label?: string;
  testID?: string;
}

export interface LogViewerProps {
  entries: LogEntry[];
  testID?: string;
}

export interface DevToolsLogPanelProps {
  title?: string;
  testID?: string;
}

export interface UseLogViewerReturn {
  entries: LogEntry[];
  filter: LogFilter;
  refresh: () => void;
  setLevelFilter: (level: LogLevel | undefined) => void;
  setSearchFilter: (search: string | undefined) => void;
  exportLogs: () => string;
}

export type { LogEntry, LogFilter, LogLevel };
