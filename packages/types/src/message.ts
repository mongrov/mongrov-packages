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
  editedBy?: Participant // who edited (v0.3.0)
  updatedAt?: string // ISO 8601 - sync high-water mark (v0.3.0)
  systemType?: string // system events: 'user_joined', 'room_renamed', etc. (v0.3.0)
  createdAt: string // ISO 8601
}

export interface MessageContent {
  type: 'text' | 'image' | 'audio' | 'video' | 'file' | 'voice' | 'location' | 'sticker' // location, sticker added v0.3.0
  text?: string
  uri?: string
  mimeType?: string
  fileName?: string
  duration?: number // audio/video seconds
  thumbnail?: string // image/video preview URI
  latitude?: number // for location content (v0.3.0)
  longitude?: number // for location content (v0.3.0)
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
