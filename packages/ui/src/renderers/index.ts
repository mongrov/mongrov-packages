/**
 * Shared Renderers
 *
 * Headless components for rendering messages, attachments, and reactions.
 * App provides actual UI — these provide logic and render props.
 */

export {
  AttachmentRenderer,
  useAttachmentRenderer,
} from './AttachmentRenderer'
export type {
  AttachmentRendererProps,
  AttachmentRenderProps,
  MimeCategory,
} from './AttachmentRenderer'

export {
  MessageRenderer,
  useMessageRenderer,
} from './MessageRenderer'
export type {
  ContentRenderProps,
  DeliveryStatusInfo,
  AttachmentRenderProps as MessageAttachmentRenderProps,
  ReactionRenderProps as MessageReactionRenderProps,
  MessageRendererProps,
  MessageRenderProps,
} from './MessageRenderer'

export {
  EMOJI_CATEGORIES,
  ReactionPicker,
  useReactionPicker,
} from './ReactionPicker'
export type {
  CurrentReactionItem,
  QuickReactionItem,
  ReactionPickerProps,
  ReactionPickerRenderProps,
  UseReactionPickerOptions,
} from './ReactionPicker'
