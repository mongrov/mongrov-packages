import type { ReactNode } from 'react';

export interface EmptyStateProps {
  icon?: ReactNode;
  title: string;
  subtitle?: string;
  action?: {
    label: string;
    onPress: () => void;
  };
  testID?: string;
}

export interface ErrorStateProps {
  title?: string;
  message: string;
  onRetry?: () => void;
  retryLabel?: string;
  testID?: string;
}

export interface LoadingStateProps {
  message?: string;
  size?: 'small' | 'large';
  testID?: string;
}

export interface NetworkBannerProps {
  isConnected: boolean;
  message?: string;
  testID?: string;
}

export type StatusBadgeVariant = 'default' | 'success' | 'error' | 'warning';

export interface StatusBadgeProps {
  label: string;
  variant?: StatusBadgeVariant;
  testID?: string;
}

export type SyncStatus = 'idle' | 'syncing' | 'error';

export interface SyncIndicatorProps {
  status: SyncStatus;
  label?: string;
  testID?: string;
}

export type ConnectionStatus = 'connected' | 'connecting' | 'disconnected';

export interface ConnectionIndicatorProps {
  status: ConnectionStatus;
  testID?: string;
}
