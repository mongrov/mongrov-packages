// Primitives (RNR-style components)
export {
  // Utils
  cn,
  // Text
  Text,
  TextClassContext,
  textVariants,
  // Button
  Button,
  buttonTextVariants,
  buttonVariants,
  // Card
  Card,
  CardContent,
  CardDescription,
  CardFooter,
  CardHeader,
  CardTitle,
  // Skeleton
  Skeleton,
  // Separator
  Separator,
} from './primitives';

export type { TextProps, TextVariant, ButtonProps } from './primitives';

// Compositions (specialized components)
export { EmptyState } from './EmptyState';
export { ErrorState } from './ErrorState';
export { LoadingState } from './LoadingState';
export { NetworkBanner } from './NetworkBanner';
export { StatusBadge } from './StatusBadge';
export { SyncIndicator } from './SyncIndicator';
export { ConnectionIndicator } from './ConnectionIndicator';

// Auth components
export { SocialLoginButton } from './SocialLoginButton';
export { SSOButton } from './SSOButton';
export { AuthDivider } from './AuthDivider';

// Types
export type {
  EmptyStateProps,
  ErrorStateProps,
  LoadingStateProps,
  NetworkBannerProps,
  StatusBadgeProps,
  StatusBadgeVariant,
  SyncIndicatorProps,
  SyncStatus,
  ConnectionIndicatorProps,
  ConnectionStatus,
} from './types';

// Auth component types
export type { SocialLoginButtonProps, SocialProvider } from './SocialLoginButton';
export type { SSOButtonProps } from './SSOButton';
export type { AuthDividerProps } from './AuthDivider';
