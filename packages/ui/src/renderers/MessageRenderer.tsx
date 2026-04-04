/**
 * MessageRenderer - Headless message rendering component
 *
 * Provides render props for different message content types.
 * App provides the actual UI components.
 */

import { useMemo, type ReactNode } from 'react'
import type {
  Message,
  MessageContent,
  Attachment,
  Reaction,
  DeliveryStatus,
} from '@mongrov/types'

// ─── Types ──────────────────────────────────────────────────────────────────

export interface MessageRendererProps {
  /** The message to render */
  message: Message
  /** Current user ID (for identifying own messages) */
  currentUserId?: string
  /** Render function for the message */
  children: (renderProps: MessageRenderProps) => ReactNode
}

export interface MessageRenderProps {
  /** The original message */
  message: Message
  /** Whether this message is from the current user */
  isOwnMessage: boolean
  /** Whether this message is a reply to another message */
  isReply: boolean
  /** Whether the message content is still streaming */
  isStreaming: boolean
  /** Formatted timestamp string */
  timestamp: string
  /** Delivery status for display */
  deliveryStatus: DeliveryStatusInfo
  /** Content render helpers */
  content: ContentRenderProps
  /** Attachment render helpers */
  attachments: AttachmentRenderProps
  /** Reaction render helpers */
  reactions: ReactionRenderProps
}

export interface DeliveryStatusInfo {
  status: DeliveryStatus
  label: string
  icon: 'sending' | 'sent' | 'delivered' | 'read' | 'failed'
}

export interface ContentRenderProps {
  /** Content type */
  type: MessageContent['type']
  /** Text content (if type is 'text') */
  text?: string
  /** Media URI (if type is image/audio/video/file) */
  uri?: string
  /** File name (if applicable) */
  fileName?: string
  /** MIME type */
  mimeType?: string
  /** Duration in seconds (for audio/video) */
  duration?: number
  /** Thumbnail URI (for image/video) */
  thumbnail?: string
  /** Whether content has text */
  hasText: boolean
  /** Whether content has media */
  hasMedia: boolean
}

export interface AttachmentRenderProps {
  /** All attachments */
  items: Attachment[]
  /** Number of attachments */
  count: number
  /** Whether there are attachments */
  hasAttachments: boolean
  /** Group attachments by type */
  byType: {
    images: Attachment[]
    videos: Attachment[]
    audio: Attachment[]
    files: Attachment[]
  }
}

export interface ReactionRenderProps {
  /** All reactions */
  items: Reaction[]
  /** Total reaction count */
  totalCount: number
  /** Whether there are reactions */
  hasReactions: boolean
  /** Whether current user has reacted */
  hasUserReacted: (emoji: string, userId: string) => boolean
  /** Get sorted reactions (most popular first) */
  sorted: Reaction[]
}

// ─── Helpers ────────────────────────────────────────────────────────────────

function formatTimestamp(isoString: string): string {
  try {
    const date = new Date(isoString)
    const now = new Date()
    const diffMs = now.getTime() - date.getTime()
    const diffMins = Math.floor(diffMs / 60000)
    const diffHours = Math.floor(diffMs / 3600000)
    const diffDays = Math.floor(diffMs / 86400000)

    if (diffMins < 1) return 'now'
    if (diffMins < 60) return `${diffMins}m`
    if (diffHours < 24) return `${diffHours}h`
    if (diffDays < 7) return `${diffDays}d`

    return date.toLocaleDateString(undefined, {
      month: 'short',
      day: 'numeric',
    })
  } catch {
    return ''
  }
}

function getDeliveryStatusInfo(status: DeliveryStatus): DeliveryStatusInfo {
  const statusMap: Record<DeliveryStatus, DeliveryStatusInfo> = {
    sending: { status: 'sending', label: 'Sending', icon: 'sending' },
    sent: { status: 'sent', label: 'Sent', icon: 'sent' },
    delivered: { status: 'delivered', label: 'Delivered', icon: 'delivered' },
    read: { status: 'read', label: 'Read', icon: 'read' },
    failed: { status: 'failed', label: 'Failed', icon: 'failed' },
  }
  return statusMap[status]
}

function groupAttachmentsByType(attachments: Attachment[]): AttachmentRenderProps['byType'] {
  return {
    images: attachments.filter((a) => a.type === 'image'),
    videos: attachments.filter((a) => a.type === 'video'),
    audio: attachments.filter((a) => a.type === 'audio'),
    files: attachments.filter((a) => a.type === 'file'),
  }
}

// ─── Hook ───────────────────────────────────────────────────────────────────

/**
 * Hook for message rendering logic.
 * Use this when you need the render props outside of MessageRenderer.
 */
export function useMessageRenderer(
  message: Message,
  currentUserId?: string
): MessageRenderProps {
  return useMemo(() => {
    const { content, attachments = [], reactions = [] } = message

    const isOwnMessage = currentUserId
      ? message.sender.id === currentUserId
      : false

    const contentProps: ContentRenderProps = {
      type: content.type,
      text: content.text,
      uri: content.uri,
      fileName: content.fileName,
      mimeType: content.mimeType,
      duration: content.duration,
      thumbnail: content.thumbnail,
      hasText: !!content.text,
      hasMedia: !!content.uri,
    }

    const attachmentProps: AttachmentRenderProps = {
      items: attachments,
      count: attachments.length,
      hasAttachments: attachments.length > 0,
      byType: groupAttachmentsByType(attachments),
    }

    const sortedReactions = [...reactions].sort((a, b) => b.count - a.count)
    const totalReactionCount = reactions.reduce((sum, r) => sum + r.count, 0)

    const reactionProps: ReactionRenderProps = {
      items: reactions,
      totalCount: totalReactionCount,
      hasReactions: reactions.length > 0,
      hasUserReacted: (emoji: string, userId: string) => {
        const reaction = reactions.find((r) => r.emoji === emoji)
        return reaction?.userIds.includes(userId) ?? false
      },
      sorted: sortedReactions,
    }

    return {
      message,
      isOwnMessage,
      isReply: !!message.parentId,
      isStreaming: message.streaming ?? false,
      timestamp: formatTimestamp(message.createdAt),
      deliveryStatus: getDeliveryStatusInfo(message.deliveryStatus),
      content: contentProps,
      attachments: attachmentProps,
      reactions: reactionProps,
    }
  }, [message, currentUserId])
}

// ─── Component ──────────────────────────────────────────────────────────────

/**
 * Headless message renderer component.
 *
 * @example
 * ```tsx
 * <MessageRenderer message={msg} currentUserId={userId}>
 *   {({ isOwnMessage, content, timestamp, deliveryStatus }) => (
 *     <View style={isOwnMessage ? styles.ownMessage : styles.otherMessage}>
 *       {content.hasText && <Text>{content.text}</Text>}
 *       <Text style={styles.timestamp}>{timestamp}</Text>
 *       {isOwnMessage && <StatusIcon status={deliveryStatus.icon} />}
 *     </View>
 *   )}
 * </MessageRenderer>
 * ```
 */
export function MessageRenderer({
  message,
  currentUserId,
  children,
}: MessageRendererProps): ReactNode {
  const renderProps = useMessageRenderer(message, currentUserId)
  return children(renderProps)
}
