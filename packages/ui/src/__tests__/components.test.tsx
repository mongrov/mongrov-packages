import React from 'react';
import { create, act } from 'react-test-renderer';
import { EmptyState } from '../EmptyState';
import { ErrorState } from '../ErrorState';
import { LoadingState } from '../LoadingState';
import { NetworkBanner } from '../NetworkBanner';
import { StatusBadge } from '../StatusBadge';
import { SyncIndicator } from '../SyncIndicator';
import { ConnectionIndicator } from '../ConnectionIndicator';

describe('EmptyState', () => {
  it('renders title', () => {
    const tree = create(<EmptyState title="No items" />);
    const root = tree.root;
    const texts = root.findAllByType('Text' as any);
    expect(texts.some(t => t.children.includes('No items'))).toBe(true);
  });

  it('renders subtitle when provided', () => {
    const tree = create(<EmptyState title="No items" subtitle="Add some items" />);
    const texts = tree.root.findAllByType('Text' as any);
    expect(texts.some(t => t.children.includes('Add some items'))).toBe(true);
  });

  it('renders action button when provided', () => {
    const onPress = jest.fn();
    const tree = create(
      <EmptyState title="No items" action={{ label: 'Add', onPress }} testID="empty" />,
    );
    const button = tree.root.findByProps({ testID: 'empty-action' });
    expect(button).toBeTruthy();
    act(() => {
      button.props.onPress();
    });
    expect(onPress).toHaveBeenCalled();
  });

  it('does not render action when not provided', () => {
    const tree = create(<EmptyState title="No items" testID="empty" />);
    expect(() => tree.root.findByProps({ testID: 'empty-action' })).toThrow();
  });

  it('renders icon when provided', () => {
    const icon = React.createElement('View', { testID: 'icon' });
    const tree = create(<EmptyState title="No items" icon={icon} />);
    expect(tree.root.findByProps({ testID: 'icon' })).toBeTruthy();
  });
});

describe('ErrorState', () => {
  it('renders default title and message', () => {
    const tree = create(<ErrorState message="Network error" />);
    const texts = tree.root.findAllByType('Text' as any);
    expect(texts.some(t => t.children.includes('Something went wrong'))).toBe(true);
    expect(texts.some(t => t.children.includes('Network error'))).toBe(true);
  });

  it('renders custom title', () => {
    const tree = create(<ErrorState title="Oops" message="Error" />);
    const texts = tree.root.findAllByType('Text' as any);
    expect(texts.some(t => t.children.includes('Oops'))).toBe(true);
  });

  it('renders retry button when onRetry provided', () => {
    const onRetry = jest.fn();
    const tree = create(<ErrorState message="Error" onRetry={onRetry} testID="error" />);
    const button = tree.root.findByProps({ testID: 'error-retry' });
    act(() => {
      button.props.onPress();
    });
    expect(onRetry).toHaveBeenCalled();
  });

  it('does not render retry when onRetry not provided', () => {
    const tree = create(<ErrorState message="Error" testID="error" />);
    expect(() => tree.root.findByProps({ testID: 'error-retry' })).toThrow();
  });
});

describe('LoadingState', () => {
  it('renders activity indicator', () => {
    const tree = create(<LoadingState />);
    const indicator = tree.root.findByType('ActivityIndicator' as any);
    expect(indicator).toBeTruthy();
  });

  it('renders message when provided', () => {
    const tree = create(<LoadingState message="Loading data..." />);
    const texts = tree.root.findAllByType('Text' as any);
    expect(texts.some(t => t.children.includes('Loading data...'))).toBe(true);
  });

  it('passes size prop to ActivityIndicator', () => {
    const tree = create(<LoadingState size="small" />);
    const indicator = tree.root.findByType('ActivityIndicator' as any);
    expect(indicator.props.size).toBe('small');
  });
});

describe('NetworkBanner', () => {
  it('renders nothing when connected', () => {
    const tree = create(<NetworkBanner isConnected={true} testID="banner" />);
    expect(tree.toJSON()).toBeNull();
  });

  it('renders banner when disconnected', () => {
    const tree = create(<NetworkBanner isConnected={false} testID="banner" />);
    expect(tree.root.findByProps({ testID: 'banner' })).toBeTruthy();
  });

  it('shows default message', () => {
    const tree = create(<NetworkBanner isConnected={false} />);
    const texts = tree.root.findAllByType('Text' as any);
    expect(texts.some(t => t.children.includes('No internet connection'))).toBe(true);
  });

  it('shows custom message', () => {
    const tree = create(<NetworkBanner isConnected={false} message="Offline mode" />);
    const texts = tree.root.findAllByType('Text' as any);
    expect(texts.some(t => t.children.includes('Offline mode'))).toBe(true);
  });
});

describe('StatusBadge', () => {
  it('renders label', () => {
    const tree = create(<StatusBadge label="Active" />);
    const texts = tree.root.findAllByType('Text' as any);
    expect(texts.some(t => t.children.includes('Active'))).toBe(true);
  });

  it('renders with default variant', () => {
    const tree = create(<StatusBadge label="Active" testID="badge" />);
    expect(tree.root.findByProps({ testID: 'badge' })).toBeTruthy();
  });

  it('renders each variant', () => {
    const variants = ['default', 'success', 'error', 'warning'] as const;
    for (const variant of variants) {
      const tree = create(<StatusBadge label="Test" variant={variant} testID="badge" />);
      expect(tree.root.findByProps({ testID: 'badge' })).toBeTruthy();
    }
  });
});

describe('SyncIndicator', () => {
  it('renders idle state', () => {
    const tree = create(<SyncIndicator status="idle" />);
    const texts = tree.root.findAllByType('Text' as any);
    expect(texts.some(t => t.children.includes('Synced'))).toBe(true);
  });

  it('renders syncing state', () => {
    const tree = create(<SyncIndicator status="syncing" />);
    const texts = tree.root.findAllByType('Text' as any);
    expect(texts.some(t => t.children.includes('Syncing...'))).toBe(true);
  });

  it('renders error state', () => {
    const tree = create(<SyncIndicator status="error" />);
    const texts = tree.root.findAllByType('Text' as any);
    expect(texts.some(t => t.children.includes('Sync error'))).toBe(true);
  });

  it('renders custom label', () => {
    const tree = create(<SyncIndicator status="idle" label="All good" />);
    const texts = tree.root.findAllByType('Text' as any);
    expect(texts.some(t => t.children.includes('All good'))).toBe(true);
  });
});

describe('ConnectionIndicator', () => {
  it('renders connected state', () => {
    const tree = create(<ConnectionIndicator status="connected" testID="conn" />);
    expect(tree.root.findByProps({ testID: 'conn' })).toBeTruthy();
  });

  it('renders disconnected state', () => {
    const tree = create(<ConnectionIndicator status="disconnected" testID="conn" />);
    expect(tree.root.findByProps({ testID: 'conn' })).toBeTruthy();
  });

  it('renders connecting state', () => {
    const tree = create(<ConnectionIndicator status="connecting" testID="conn" />);
    expect(tree.root.findByProps({ testID: 'conn' })).toBeTruthy();
  });
});
