export { AuthDivider } from './AuthDivider'

export type { AuthDividerProps } from './AuthDivider'

export { ConnectionIndicator } from './ConnectionIndicator'
// Compositions (specialized components)
export { EmptyState } from './EmptyState'
export { ErrorState } from './ErrorState'
export { LoadingState } from './LoadingState'
export { NetworkBanner } from './NetworkBanner'
// Primitives (RNR-style components)
export {
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
  // Utils
  cn,
  // Separator
  Separator,
  // Skeleton
  Skeleton,
  // Text
  Text,
  TextClassContext,
  textVariants,
} from './primitives'
export type { ButtonProps, TextProps, TextVariant } from './primitives'

// Renderers (headless components)
export {
  AttachmentRenderer,
  EMOJI_CATEGORIES,
  MessageRenderer,
  ReactionPicker,
  useAttachmentRenderer,
  useMessageRenderer,
  useReactionPicker,
} from './renderers'
export type {
  AttachmentRendererProps,
  AttachmentRenderProps,
  ContentRenderProps,
  CurrentReactionItem,
  DeliveryStatusInfo,
  MessageAttachmentRenderProps,
  MessageReactionRenderProps,
  MessageRendererProps,
  MessageRenderProps,
  MimeCategory,
  QuickReactionItem,
  ReactionPickerProps,
  ReactionPickerRenderProps,
  UseReactionPickerOptions,
} from './renderers'
// Auth components
export { SocialLoginButton } from './SocialLoginButton'
// Auth component types
export type { SocialLoginButtonProps, SocialProvider } from './SocialLoginButton'

export { SSOButton } from './SSOButton'

export type { SSOButtonProps } from './SSOButton'
export { StatusBadge } from './StatusBadge'
export { SyncIndicator } from './SyncIndicator'
export { TenantPicker, TenantSelector } from './TenantPicker'

export type { TenantPickerItem, TenantPickerProps, TenantSelectorProps } from './TenantPicker'

// Types
export type {
  ConnectionIndicatorProps,
  ConnectionStatus,
  EmptyStateProps,
  ErrorStateProps,
  LoadingStateProps,
  NetworkBannerProps,
  StatusBadgeProps,
  StatusBadgeVariant,
  SyncIndicatorProps,
  SyncStatus,
} from './types'
