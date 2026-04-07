/**
 * Type-level compile tests for @mongrov/types
 *
 * These tests verify that types work correctly at compile time.
 * If TypeScript compiles this file without errors, the types are valid.
 */

import type {
  // Message types
  Message,
  MessageContent,
  Attachment,
  Reaction,
  DeliveryStatus,
  // Conversation types
  Conversation,
  Member,
  CreateConversationConfig,
  ConversationType,
  GroupState,
  // Participant types
  Participant,
  ParticipantType,
  MemberRole,
  PresenceStatus,
  // Common types
  Pagination,
  Unsubscribe,
  ConnectionStatus,
  FileUpload,
  SearchOpts,
} from '../index'

// ─── Participant Type Tests ────────────────────────────────────────────────

describe('Participant types', () => {
  it('should create valid Participant', () => {
    const human: Participant = {
      id: 'user-1',
      name: 'John Doe',
      avatar: 'https://example.com/avatar.png',
      type: 'human',
    }

    const ai: Participant = {
      id: 'ai-1',
      name: 'Claude',
      type: 'ai',
    }

    const bot: Participant = {
      id: 'bot-1',
      name: 'Support Bot',
      type: 'bot',
    }

    const system: Participant = {
      id: 'system',
      name: 'System',
      type: 'system',
    }

    expect(human.type).toBe('human')
    expect(ai.type).toBe('ai')
    expect(bot.type).toBe('bot')
    expect(system.type).toBe('system')
  })

  it('should have correct ParticipantType values', () => {
    const types: ParticipantType[] = ['human', 'ai', 'bot', 'system']
    expect(types).toHaveLength(4)
  })

  it('should have correct MemberRole values', () => {
    const roles: MemberRole[] = ['owner', 'admin', 'moderator', 'member']
    expect(roles).toHaveLength(4)
  })

  it('should have correct PresenceStatus values', () => {
    const statuses: PresenceStatus[] = ['online', 'away', 'busy', 'offline']
    expect(statuses).toHaveLength(4)
  })
})

// ─── Message Type Tests ────────────────────────────────────────────────────

describe('Message types', () => {
  it('should create valid Message with required fields', () => {
    const sender: Participant = { id: 'user-1', name: 'John', type: 'human' }

    const message: Message = {
      id: 'msg-1',
      conversationId: 'conv-1',
      sender,
      content: { type: 'text', text: 'Hello world' },
      deliveryStatus: 'sent',
      createdAt: new Date().toISOString(),
    }

    expect(message.id).toBe('msg-1')
    expect(message.content.type).toBe('text')
  })

  it('should create valid Message with all optional fields', () => {
    const sender: Participant = { id: 'ai-1', name: 'Claude', type: 'ai' }

    const message: Message = {
      id: 'msg-2',
      conversationId: 'conv-1',
      sender,
      content: { type: 'text', text: 'Response' },
      parentId: 'msg-1',
      attachments: [
        {
          id: 'att-1',
          type: 'image',
          uri: 'https://example.com/image.png',
          fileName: 'image.png',
          mimeType: 'image/png',
          size: 1024,
        },
      ],
      reactions: [{ emoji: '👍', userIds: ['user-1'], count: 1 }],
      mentions: ['user-2', 'user-3'],
      deliveryStatus: 'delivered',
      streaming: true,
      metadata: { model: 'claude-3', tokens: 150 },
      editedAt: new Date().toISOString(),
      createdAt: new Date().toISOString(),
    }

    expect(message.streaming).toBe(true)
    expect(message.attachments).toHaveLength(1)
    expect(message.reactions).toHaveLength(1)
  })

  it('should support all MessageContent types', () => {
    const textContent: MessageContent = { type: 'text', text: 'Hello' }
    const imageContent: MessageContent = {
      type: 'image',
      uri: 'https://example.com/img.png',
      mimeType: 'image/png',
    }
    const audioContent: MessageContent = {
      type: 'audio',
      uri: 'https://example.com/audio.mp3',
      mimeType: 'audio/mpeg',
      duration: 30,
    }
    const videoContent: MessageContent = {
      type: 'video',
      uri: 'https://example.com/video.mp4',
      mimeType: 'video/mp4',
      duration: 120,
      thumbnail: 'https://example.com/thumb.jpg',
    }
    const fileContent: MessageContent = {
      type: 'file',
      uri: 'https://example.com/doc.pdf',
      fileName: 'document.pdf',
      mimeType: 'application/pdf',
    }
    const voiceContent: MessageContent = {
      type: 'voice',
      uri: 'https://example.com/voice.ogg',
      mimeType: 'audio/ogg',
      duration: 5,
    }
    // v0.3.0 additions
    const locationContent: MessageContent = {
      type: 'location',
      text: 'Meeting point',
      latitude: 37.7749,
      longitude: -122.4194,
    }
    const stickerContent: MessageContent = {
      type: 'sticker',
      uri: 'https://example.com/sticker.webp',
      mimeType: 'image/webp',
    }

    expect(textContent.type).toBe('text')
    expect(imageContent.type).toBe('image')
    expect(audioContent.type).toBe('audio')
    expect(videoContent.type).toBe('video')
    expect(fileContent.type).toBe('file')
    expect(voiceContent.type).toBe('voice')
    expect(locationContent.type).toBe('location')
    expect(locationContent.latitude).toBe(37.7749)
    expect(stickerContent.type).toBe('sticker')
  })

  it('should create Message with v0.3.0 fields (updatedAt, editedBy, systemType)', () => {
    const editor: Participant = { id: 'user-2', name: 'Editor', type: 'human' }
    const sender: Participant = { id: 'user-1', name: 'John', type: 'human' }

    const editedMessage: Message = {
      id: 'msg-edited',
      conversationId: 'conv-1',
      sender,
      content: { type: 'text', text: 'Edited content' },
      deliveryStatus: 'delivered',
      editedAt: '2026-04-05T12:00:00Z',
      editedBy: editor,
      updatedAt: '2026-04-05T12:00:00Z',
      createdAt: '2026-04-05T10:00:00Z',
    }

    const systemMessage: Message = {
      id: 'msg-system',
      conversationId: 'conv-1',
      sender: { id: 'system', name: 'System', type: 'system' },
      content: { type: 'text', text: 'User joined the room' },
      deliveryStatus: 'delivered',
      systemType: 'user_joined',
      createdAt: '2026-04-05T10:00:00Z',
    }

    expect(editedMessage.editedBy?.id).toBe('user-2')
    expect(editedMessage.updatedAt).toBe('2026-04-05T12:00:00Z')
    expect(systemMessage.systemType).toBe('user_joined')
  })

  it('should have correct DeliveryStatus values', () => {
    const statuses: DeliveryStatus[] = ['sending', 'sent', 'delivered', 'read', 'failed']
    expect(statuses).toHaveLength(5)
  })

  it('should create valid Attachment', () => {
    const attachment: Attachment = {
      id: 'att-1',
      type: 'image',
      uri: 'https://example.com/image.png',
      fileName: 'image.png',
      mimeType: 'image/png',
      size: 2048,
      thumbnail: 'https://example.com/thumb.png',
    }

    expect(attachment.type).toBe('image')
  })

  it('should create valid Reaction', () => {
    const reaction: Reaction = {
      emoji: '❤️',
      userIds: ['user-1', 'user-2'],
      count: 2,
    }

    expect(reaction.count).toBe(2)
    expect(reaction.userIds).toHaveLength(2)
  })
})

// ─── Conversation Type Tests ───────────────────────────────────────────────

describe('Conversation types', () => {
  it('should create valid Conversation with required fields', () => {
    const member: Member = {
      user: { id: 'user-1', name: 'John', type: 'human' },
      role: 'owner',
      joinedAt: new Date().toISOString(),
    }

    const conversation: Conversation = {
      id: 'conv-1',
      type: '1:1',
      members: [member],
      unreadCount: 0,
      muted: false,
      pinned: false,
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
    }

    expect(conversation.type).toBe('1:1')
    expect(conversation.members).toHaveLength(1)
  })

  it('should create valid group Conversation with all fields', () => {
    const conversation: Conversation = {
      id: 'conv-2',
      type: 'group',
      groupState: 'open',
      name: 'Project Team',
      avatar: 'https://example.com/group.png',
      members: [],
      lastMessage: {
        id: 'msg-1',
        conversationId: 'conv-2',
        sender: { id: 'user-1', name: 'John', type: 'human' },
        content: { type: 'text', text: 'Latest message' },
        deliveryStatus: 'delivered',
        createdAt: new Date().toISOString(),
      },
      unreadCount: 5,
      muted: true,
      pinned: true,
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
    }

    expect(conversation.groupState).toBe('open')
    expect(conversation.lastMessage?.content.text).toBe('Latest message')
  })

  it('should have correct ConversationType values', () => {
    const types: ConversationType[] = ['1:1', 'group', 'channel']
    expect(types).toHaveLength(3)
  })

  it('should have correct GroupState values', () => {
    const states: GroupState[] = ['invited', 'open', 'read-only', 'closed', 'archived']
    expect(states).toHaveLength(5)
  })

  it('should create valid CreateConversationConfig', () => {
    const config: CreateConversationConfig = {
      type: 'group',
      name: 'New Group',
      memberIds: ['user-1', 'user-2'],
      groupState: 'open',
    }

    expect(config.type).toBe('group')
    expect(config.memberIds).toHaveLength(2)
  })

  it('should create valid Member', () => {
    const member: Member = {
      user: { id: 'user-1', name: 'Admin', type: 'human' },
      role: 'admin',
      joinedAt: new Date().toISOString(),
    }

    expect(member.role).toBe('admin')
  })

  it('should create Conversation with v0.3.0 fields (topic, description, metadata)', () => {
    const conversation: Conversation = {
      id: 'conv-3',
      type: 'channel',
      groupState: 'open',
      name: 'Engineering',
      members: [],
      unreadCount: 0,
      muted: false,
      pinned: false,
      topic: 'Engineering team discussions',
      description: 'A channel for the engineering team to collaborate',
      metadata: {
        encrypted: true,
        teamId: 'team-123',
        broadcast: false,
      },
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
    }

    expect(conversation.topic).toBe('Engineering team discussions')
    expect(conversation.description).toContain('engineering team')
    expect(conversation.metadata?.encrypted).toBe(true)
    expect(conversation.metadata?.teamId).toBe('team-123')
  })
})

// ─── Common Type Tests ─────────────────────────────────────────────────────

describe('Common types', () => {
  it('should create valid Pagination', () => {
    const pagination: Pagination = {
      limit: 20,
      before: '2024-01-01T00:00:00Z',
      after: '2023-12-01T00:00:00Z',
    }

    expect(pagination.limit).toBe(20)
  })

  it('should create valid Pagination with minimal fields', () => {
    const pagination: Pagination = {}
    expect(pagination.limit).toBeUndefined()
  })

  it('should create valid Unsubscribe function', () => {
    const unsubscribe: Unsubscribe = () => {
      // cleanup
    }

    expect(typeof unsubscribe).toBe('function')
    unsubscribe() // should not throw
  })

  it('should have correct ConnectionStatus values', () => {
    const statuses: ConnectionStatus[] = [
      'connected',
      'connecting',
      'disconnected',
      'reconnecting',
    ]
    expect(statuses).toHaveLength(4)
  })

  it('should create valid FileUpload', () => {
    const upload: FileUpload = {
      uri: 'file:///path/to/file.pdf',
      fileName: 'document.pdf',
      mimeType: 'application/pdf',
      size: 1024000,
    }

    expect(upload.fileName).toBe('document.pdf')
  })

  it('should create valid FileUpload without optional size', () => {
    const upload: FileUpload = {
      uri: 'file:///path/to/image.png',
      fileName: 'image.png',
      mimeType: 'image/png',
    }

    expect(upload.size).toBeUndefined()
  })

  it('should create valid SearchOpts', () => {
    const opts: SearchOpts = {
      conversationId: 'conv-1',
      limit: 50,
      offset: 10,
    }

    expect(opts.limit).toBe(50)
  })

  it('should create valid SearchOpts with minimal fields', () => {
    const opts: SearchOpts = {}
    expect(opts.conversationId).toBeUndefined()
  })
})
