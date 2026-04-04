/**
 * Message types for AI and collab messaging
 */

import type { Participant } from './participant'

export interface Message {
  id: string
  conversationId: string
  sender: Participant
  content: MessageContent
  parentId?: string // reply-to
  attachments?: Attachment[]
  reactions?: Reaction[]
  mentions?: string[] // user IDs
  deliveryStatus: DeliveryStatus
  streaming?: boolean // true while AI is generating
  metadata?: Record<string, unknown> // tool results, model info, etc.
  editedAt?: string // ISO 8601
  createdAt: string // ISO 8601
}

export interface MessageContent {
  type: 'text' | 'image' | 'audio' | 'video' | 'file' | 'voice'
  text?: string
  uri?: string
  mimeType?: string
  fileName?: string
  duration?: number // audio/video seconds
  thumbnail?: string // image/video preview URI
}

export interface Attachment {
  id: string
  type: 'image' | 'audio' | 'video' | 'file'
  uri: string
  fileName: string
  mimeType: string
  size?: number // bytes
  thumbnail?: string
  duration?: number
}

export interface Reaction {
  emoji: string
  userIds: string[]
  count: number
}

export type DeliveryStatus = 'sending' | 'sent' | 'delivered' | 'read' | 'failed'
