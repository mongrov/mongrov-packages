/**
 * Participant types for messaging systems
 */

export interface Participant {
  id: string
  name: string
  avatar?: string
  type: ParticipantType
}

export type ParticipantType = 'human' | 'ai' | 'bot' | 'system'

export type MemberRole = 'owner' | 'admin' | 'moderator' | 'member'

export type PresenceStatus = 'online' | 'away' | 'busy' | 'offline'
