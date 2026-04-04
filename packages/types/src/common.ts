/**
 * Common utility types shared across packages
 */

export interface Pagination {
  limit?: number
  before?: string // cursor or ISO date
  after?: string
}

export type Unsubscribe = () => void

export type ConnectionStatus = 'connected' | 'connecting' | 'disconnected' | 'reconnecting'

export interface FileUpload {
  uri: string
  fileName: string
  mimeType: string
  size?: number
}

export interface SearchOpts {
  conversationId?: string
  limit?: number
  offset?: number
}
