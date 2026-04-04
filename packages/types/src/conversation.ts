/**
 * Conversation types for messaging systems
 */

import type { Message } from './message'
import type { MemberRole, Participant } from './participant'

export interface Conversation {
  id: string
  type: ConversationType
  groupState?: GroupState
  name?: string
  avatar?: string
  members: Member[]
  lastMessage?: Message
  unreadCount: number
  muted: boolean
  pinned: boolean
  createdAt: string
  updatedAt: string
}

export interface Member {
  user: Participant
  role: MemberRole
  joinedAt: string
}

export interface CreateConversationConfig {
  type: ConversationType
  name?: string
  memberIds: string[]
  groupState?: GroupState
}

export type ConversationType = '1:1' | 'group' | 'channel'

export type GroupState = 'invited' | 'open' | 'read-only' | 'closed' | 'archived'
