import React from 'react';
import { create, act } from 'react-test-renderer';
import { EmptyState } from '../EmptyState';
import { ErrorState } from '../ErrorState';
import { LoadingState } from '../LoadingState';
import { NetworkBanner } from '../NetworkBanner';
import { StatusBadge } from '../StatusBadge';
import { SyncIndicator } from '../SyncIndicator';
import { ConnectionIndicator } from '../ConnectionIndicator';

// Helper to find all text-like elements (span in our mocks)
function findAllTexts(root: any): any[] {
  return root.findAllByType('span');
}

// Helper to check if any text element contains the given string
function hasText(root: any, text: string): boolean {
  const texts = findAllTexts(root);
  return texts.some((t: any) => {
    const children = Array.isArray(t.children) ? t.children : [t.children];
    return children.some((child: any) =>
      typeof child === 'string' && child.includes(text)
    );
  });
}

describe('EmptyState', () => {
  it('renders title', () => {
    const tree = create(<EmptyState title="No items" />);
    expect(hasText(tree.root, 'No items')).toBe(true);
  });

  it('renders subtitle when provided', () => {
    const tree = create(<EmptyState title="No items" subtitle="Add some items" />);
    expect(hasText(tree.root, 'Add some items')).toBe(true);
  });

  it('renders action button when provided', () => {
    const onPress = jest.fn();
    const tree = create(
      <EmptyState title="No items" action={{ label: 'Add', onPress }} testID="empty" />,
    );
    const button = tree.root.findByProps({ 'data-testid': 'empty-action' });
    expect(button).toBeTruthy();
    act(() => {
      button.props.onClick();
    });
    expect(onPress).toHaveBeenCalled();
  });

  it('does not render action when not provided', () => {
    const tree = create(<EmptyState title="No items" testID="empty" />);
    expect(() => tree.root.findByProps({ 'data-testid': 'empty-action' })).toThrow();
  });

  it('renders icon when provided', () => {
    const icon = React.createElement('div', { 'data-testid': 'icon' });
    const tree = create(<EmptyState title="No items" icon={icon} />);
    expect(tree.root.findByProps({ 'data-testid': 'icon' })).toBeTruthy();
  });
});

describe('ErrorState', () => {
  it('renders default title and message', () => {
    const tree = create(<ErrorState message="Network error" />);
    expect(hasText(tree.root, 'Something went wrong')).toBe(true);
    expect(hasText(tree.root, 'Network error')).toBe(true);
  });

  it('renders custom title', () => {
    const tree = create(<ErrorState title="Oops" message="Error" />);
    expect(hasText(tree.root, 'Oops')).toBe(true);
  });

  it('renders retry button when onRetry provided', () => {
    const onRetry = jest.fn();
    const tree = create(<ErrorState message="Error" onRetry={onRetry} testID="error" />);
    const button = tree.root.findByProps({ 'data-testid': 'error-retry' });
    act(() => {
      button.props.onClick();
    });
    expect(onRetry).toHaveBeenCalled();
  });

  it('does not render retry when onRetry not provided', () => {
    const tree = create(<ErrorState message="Error" testID="error" />);
    expect(() => tree.root.findByProps({ 'data-testid': 'error-retry' })).toThrow();
  });
});

describe('LoadingState', () => {
  it('renders activity indicator', () => {
    const tree = create(<LoadingState />);
    // ActivityIndicator is mocked as span
    expect(tree.toJSON()).toBeTruthy();
  });

  it('renders message when provided', () => {
    const tree = create(<LoadingState message="Loading data..." />);
    expect(hasText(tree.root, 'Loading data...')).toBe(true);
  });

  it('passes size prop to ActivityIndicator', () => {
    const tree = create(<LoadingState size="small" />);
    expect(tree.toJSON()).toBeTruthy();
  });
});

describe('NetworkBanner', () => {
  it('renders nothing when connected', () => {
    const tree = create(<NetworkBanner isConnected={true} testID="banner" />);
    expect(tree.toJSON()).toBeNull();
  });

  it('renders banner when disconnected', () => {
    const tree = create(<NetworkBanner isConnected={false} testID="banner" />);
    expect(tree.root.findByProps({ 'data-testid': 'banner' })).toBeTruthy();
  });

  it('shows default message', () => {
    const tree = create(<NetworkBanner isConnected={false} />);
    expect(hasText(tree.root, 'No internet connection')).toBe(true);
  });

  it('shows custom message', () => {
    const tree = create(<NetworkBanner isConnected={false} message="Offline mode" />);
    expect(hasText(tree.root, 'Offline mode')).toBe(true);
  });
});

describe('StatusBadge', () => {
  it('renders label', () => {
    const tree = create(<StatusBadge label="Active" />);
    expect(hasText(tree.root, 'Active')).toBe(true);
  });

  it('renders with default variant', () => {
    const tree = create(<StatusBadge label="Active" testID="badge" />);
    expect(tree.root.findByProps({ 'data-testid': 'badge' })).toBeTruthy();
  });

  it('renders each variant', () => {
    const variants = ['default', 'success', 'error', 'warning'] as const;
    for (const variant of variants) {
      const tree = create(<StatusBadge label="Test" variant={variant} testID="badge" />);
      expect(tree.root.findByProps({ 'data-testid': 'badge' })).toBeTruthy();
    }
  });
});

describe('SyncIndicator', () => {
  it('renders idle state', () => {
    const tree = create(<SyncIndicator status="idle" />);
    expect(hasText(tree.root, 'Synced')).toBe(true);
  });

  it('renders syncing state', () => {
    const tree = create(<SyncIndicator status="syncing" />);
    expect(hasText(tree.root, 'Syncing...')).toBe(true);
  });

  it('renders error state', () => {
    const tree = create(<SyncIndicator status="error" />);
    expect(hasText(tree.root, 'Sync error')).toBe(true);
  });

  it('renders custom label', () => {
    const tree = create(<SyncIndicator status="idle" label="All good" />);
    expect(hasText(tree.root, 'All good')).toBe(true);
  });
});

describe('ConnectionIndicator', () => {
  it('renders connected state', () => {
    const tree = create(<ConnectionIndicator status="connected" testID="conn" />);
    expect(tree.root.findByProps({ 'data-testid': 'conn' })).toBeTruthy();
  });

  it('renders disconnected state', () => {
    const tree = create(<ConnectionIndicator status="disconnected" testID="conn" />);
    expect(tree.root.findByProps({ 'data-testid': 'conn' })).toBeTruthy();
  });

  it('renders connecting state', () => {
    const tree = create(<ConnectionIndicator status="connecting" testID="conn" />);
    expect(tree.root.findByProps({ 'data-testid': 'conn' })).toBeTruthy();
  });
});
