import React from 'react';
import { create, act } from 'react-test-renderer';
import { renderHook, act as hookAct } from '@testing-library/react';
import { useLogViewer } from '../ui/useLogViewer';
import { DevToolsLogPanel } from '../ui/DevToolsLogPanel';
import { LoggingProvider } from '../context/logging-provider';
import type { LogEntry } from '../types';

const mockEntries: LogEntry[] = [
  {
    id: 'test-1',
    timestamp: '2024-01-15T10:30:00.000Z',
    level: 'info',
    message: 'Test message 1',
    context: {
      sessionId: 'session-123',
      appVersion: '1.0.0',
      platform: 'ios',
    },
  },
  {
    id: 'test-2',
    timestamp: '2024-01-15T10:31:00.000Z',
    level: 'warn',
    message: 'Test message 2',
    context: {
      sessionId: 'session-123',
      appVersion: '1.0.0',
      platform: 'ios',
    },
  },
];

// Mock logger with getLogs and exportLogs
const mockLogger = {
  getLogs: jest.fn().mockReturnValue(mockEntries),
  exportLogs: jest.fn().mockReturnValue(JSON.stringify(mockEntries)),
  debug: jest.fn(),
  info: jest.fn(),
  warn: jest.fn(),
  error: jest.fn(),
  captureException: jest.fn(),
  setUser: jest.fn(),
  setScreen: jest.fn(),
  setTenant: jest.fn(),
  flush: jest.fn(),
  getBreadcrumbs: jest.fn().mockReturnValue([]),
};

// Provider wrapper that provides the mock logger
const wrapper = ({ children }: { children: React.ReactNode }) => (
  <LoggingProvider config={{ appVersion: '1.0.0' }}>{children}</LoggingProvider>
);

describe('useLogViewer', () => {
  beforeEach(() => {
    jest.clearAllMocks();
  });

  it('returns initial empty entries', () => {
    const { result } = renderHook(() => useLogViewer(), { wrapper });
    expect(result.current.entries).toEqual([]);
  });

  it('returns filter state', () => {
    const { result } = renderHook(() => useLogViewer(), { wrapper });
    expect(result.current.filter).toEqual({});
  });

  it('provides setLevelFilter function', () => {
    const { result } = renderHook(() => useLogViewer(), { wrapper });
    hookAct(() => {
      result.current.setLevelFilter('error');
    });
    expect(result.current.filter.level).toBe('error');
  });

  it('provides setSearchFilter function', () => {
    const { result } = renderHook(() => useLogViewer(), { wrapper });
    hookAct(() => {
      result.current.setSearchFilter('test');
    });
    expect(result.current.filter.search).toBe('test');
  });

  it('clears search filter with empty string', () => {
    const { result } = renderHook(() => useLogViewer(), { wrapper });
    hookAct(() => {
      result.current.setSearchFilter('test');
    });
    hookAct(() => {
      result.current.setSearchFilter('');
    });
    expect(result.current.filter.search).toBeUndefined();
  });

  it('provides refresh function', () => {
    const { result } = renderHook(() => useLogViewer(), { wrapper });
    expect(typeof result.current.refresh).toBe('function');
  });

  it('provides exportLogs function', () => {
    const { result } = renderHook(() => useLogViewer(), { wrapper });
    const exported = result.current.exportLogs();
    expect(typeof exported).toBe('string');
  });
});

describe('DevToolsLogPanel', () => {
  it('renders with default title', () => {
    const tree = create(
      <LoggingProvider config={{ appVersion: '1.0.0' }}>
        <DevToolsLogPanel />
      </LoggingProvider>
    );
    const texts = tree.root.findAllByType('Text' as any);
    expect(texts.some((t) => t.children.includes('Dev Tools'))).toBe(true);
  });

  it('renders with custom title', () => {
    const tree = create(
      <LoggingProvider config={{ appVersion: '1.0.0' }}>
        <DevToolsLogPanel title="Custom Logs" />
      </LoggingProvider>
    );
    const texts = tree.root.findAllByType('Text' as any);
    expect(texts.some((t) => t.children.includes('Custom Logs'))).toBe(true);
  });

  it('renders filter bar', () => {
    const tree = create(
      <LoggingProvider config={{ appVersion: '1.0.0' }}>
        <DevToolsLogPanel testID="panel" />
      </LoggingProvider>
    );
    expect(tree.root.findByProps({ testID: 'panel-filter' })).toBeTruthy();
  });

  it('renders export button', () => {
    const tree = create(
      <LoggingProvider config={{ appVersion: '1.0.0' }}>
        <DevToolsLogPanel testID="panel" />
      </LoggingProvider>
    );
    expect(tree.root.findByProps({ testID: 'panel-export' })).toBeTruthy();
  });

  it('renders log viewer', () => {
    const tree = create(
      <LoggingProvider config={{ appVersion: '1.0.0' }}>
        <DevToolsLogPanel testID="panel" />
      </LoggingProvider>
    );
    expect(tree.root.findByProps({ testID: 'panel-viewer' })).toBeTruthy();
  });

  it('shows entry count', () => {
    const tree = create(
      <LoggingProvider config={{ appVersion: '1.0.0' }}>
        <DevToolsLogPanel />
      </LoggingProvider>
    );
    const texts = tree.root.findAllByType('Text' as any);
    expect(texts.some((t) => t.children.join('').includes('entries'))).toBe(true);
  });
});
