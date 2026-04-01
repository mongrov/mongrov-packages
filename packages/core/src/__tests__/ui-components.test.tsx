import React from 'react';
import { create, act } from 'react-test-renderer';
import { LogEntryRow } from '../ui/LogEntryRow';
import { LogFilterBar } from '../ui/LogFilterBar';
import { LogExportButton } from '../ui/LogExportButton';
import { LogViewer } from '../ui/LogViewer';
import type { LogEntry } from '../types';

const mockEntry: LogEntry = {
  id: 'test-1',
  timestamp: '2024-01-15T10:30:00.000Z',
  level: 'info',
  message: 'Test log message',
  context: {
    sessionId: 'session-123',
    appVersion: '1.0.0',
    platform: 'ios',
  },
};

const mockEntryWithData: LogEntry = {
  ...mockEntry,
  id: 'test-2',
  data: { userId: 'user-123', action: 'login' },
};

describe('LogEntryRow', () => {
  it('renders log entry with level and message', () => {
    const tree = create(<LogEntryRow entry={mockEntry} />);
    const texts = tree.root.findAllByType('Text' as any);
    expect(texts.some((t) => t.children.includes('info'))).toBe(true);
    expect(texts.some((t) => t.children.includes('Test log message'))).toBe(
      true
    );
  });

  it('renders timestamp', () => {
    const tree = create(<LogEntryRow entry={mockEntry} />);
    const texts = tree.root.findAllByType('Text' as any);
    // Should have a time string
    expect(
      texts.some((t) => typeof t.children[0] === 'string' && t.children[0].includes(':'))
    ).toBe(true);
  });

  it('renders data when provided', () => {
    const tree = create(<LogEntryRow entry={mockEntryWithData} />);
    const texts = tree.root.findAllByType('Text' as any);
    expect(
      texts.some(
        (t) =>
          typeof t.children[0] === 'string' && t.children[0].includes('userId')
      )
    ).toBe(true);
  });

  it('does not render data section when not provided', () => {
    const tree = create(<LogEntryRow entry={mockEntry} />);
    const texts = tree.root.findAllByType('Text' as any);
    expect(texts.length).toBe(3); // level, time, message
  });

  it('renders different level styles', () => {
    const levels = ['debug', 'info', 'warn', 'error'] as const;
    for (const level of levels) {
      const entry = { ...mockEntry, level };
      const tree = create(<LogEntryRow entry={entry} />);
      const texts = tree.root.findAllByType('Text' as any);
      expect(texts.some((t) => t.children.includes(level))).toBe(true);
    }
  });
});

describe('LogFilterBar', () => {
  it('renders all filter levels', () => {
    const onSelectLevel = jest.fn();
    const tree = create(
      <LogFilterBar activeLevel={undefined} onSelectLevel={onSelectLevel} />
    );
    const texts = tree.root.findAllByType('Text' as any);
    expect(texts.some((t) => t.children.includes('all'))).toBe(true);
    expect(texts.some((t) => t.children.includes('debug'))).toBe(true);
    expect(texts.some((t) => t.children.includes('info'))).toBe(true);
    expect(texts.some((t) => t.children.includes('warn'))).toBe(true);
    expect(texts.some((t) => t.children.includes('error'))).toBe(true);
  });

  it('calls onSelectLevel when level is pressed', () => {
    const onSelectLevel = jest.fn();
    const tree = create(
      <LogFilterBar
        activeLevel={undefined}
        onSelectLevel={onSelectLevel}
        testID="filter"
      />
    );
    const infoButton = tree.root.findByProps({ testID: 'filter-info' });
    act(() => {
      infoButton.props.onPress();
    });
    expect(onSelectLevel).toHaveBeenCalledWith('info');
  });

  it('calls onSelectLevel with undefined when "all" is pressed', () => {
    const onSelectLevel = jest.fn();
    const tree = create(
      <LogFilterBar
        activeLevel="info"
        onSelectLevel={onSelectLevel}
        testID="filter"
      />
    );
    const allButton = tree.root.findByProps({ testID: 'filter-all' });
    act(() => {
      allButton.props.onPress();
    });
    expect(onSelectLevel).toHaveBeenCalledWith(undefined);
  });
});

describe('LogExportButton', () => {
  it('renders with default label', () => {
    const tree = create(<LogExportButton getExportData={() => '[]'} />);
    const texts = tree.root.findAllByType('Text' as any);
    expect(texts.some((t) => t.children.includes('Export Logs'))).toBe(true);
  });

  it('renders with custom label', () => {
    const tree = create(
      <LogExportButton getExportData={() => '[]'} label="Download" />
    );
    const texts = tree.root.findAllByType('Text' as any);
    expect(texts.some((t) => t.children.includes('Download'))).toBe(true);
  });

  it('calls getExportData when pressed', async () => {
    const getExportData = jest.fn().mockReturnValue('[]');
    const tree = create(
      <LogExportButton getExportData={getExportData} testID="export" />
    );
    const pressable = tree.root.findByType('Pressable' as any);
    await act(async () => {
      await pressable.props.onPress();
    });
    expect(getExportData).toHaveBeenCalled();
  });
});

describe('LogViewer', () => {
  it('renders empty list', () => {
    const tree = create(<LogViewer entries={[]} testID="viewer" />);
    expect(tree.root.findByProps({ testID: 'viewer' })).toBeTruthy();
  });

  it('renders list of entries', () => {
    const entries = [mockEntry, { ...mockEntry, id: 'test-2' }];
    const tree = create(<LogViewer entries={entries} />);
    const flatList = tree.root.findByType('FlatList' as any);
    expect(flatList.props.data).toHaveLength(2);
  });

  it('uses entry id as key', () => {
    const entries = [mockEntry];
    const tree = create(<LogViewer entries={entries} />);
    const flatList = tree.root.findByType('FlatList' as any);
    expect(flatList.props.keyExtractor(mockEntry)).toBe('test-1');
  });
});
