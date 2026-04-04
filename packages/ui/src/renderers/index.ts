/**
 * Shared Renderers
 *
 * Headless components for rendering messages, attachments, and reactions.
 * App provides actual UI — these provide logic and render props.
 */

export {
  MessageRenderer,
  useMessageRenderer,
} from './MessageRenderer'
export type {
  MessageRendererProps,
  MessageRenderProps,
  DeliveryStatusInfo,
  ContentRenderProps,
  AttachmentRenderProps as MessageAttachmentRenderProps,
  ReactionRenderProps as MessageReactionRenderProps,
} from './MessageRenderer'

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
  ReactionPicker,
  useReactionPicker,
  EMOJI_CATEGORIES,
} from './ReactionPicker'
export type {
  ReactionPickerProps,
  ReactionPickerRenderProps,
  QuickReactionItem,
  CurrentReactionItem,
  UseReactionPickerOptions,
} from './ReactionPicker'
