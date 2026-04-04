import React from 'react'
import { renderHook, act } from '@testing-library/react'
import { create } from 'react-test-renderer'
import {
  MessageRenderer,
  useMessageRenderer,
  AttachmentRenderer,
  useAttachmentRenderer,
  ReactionPicker,
  useReactionPicker,
} from '../renderers'
import type { Message, Attachment, Reaction } from '@mongrov/types'

// ─── Test Data ──────────────────────────────────────────────────────────────

const createMessage = (overrides?: Partial<Message>): Message => ({
  id: 'msg-1',
  conversationId: 'conv-1',
  sender: {
    id: 'user-1',
    name: 'Alice',
    type: 'human',
  },
  content: {
    type: 'text',
    text: 'Hello world',
  },
  deliveryStatus: 'sent',
  createdAt: new Date().toISOString(),
  ...overrides,
})

const createAttachment = (overrides?: Partial<Attachment>): Attachment => ({
  id: 'att-1',
  type: 'image',
  uri: 'https://example.com/image.jpg',
  fileName: 'image.jpg',
  mimeType: 'image/jpeg',
  size: 1024 * 100, // 100KB
  ...overrides,
})

// ─── MessageRenderer Tests ──────────────────────────────────────────────────

describe('useMessageRenderer', () => {
  it('should identify own message', () => {
    const message = createMessage({ sender: { id: 'me', name: 'Me', type: 'human' } })
    const { result } = renderHook(() => useMessageRenderer(message, 'me'))

    expect(result.current.isOwnMessage).toBe(true)
  })

  it('should identify other message', () => {
    const message = createMessage()
    const { result } = renderHook(() => useMessageRenderer(message, 'me'))

    expect(result.current.isOwnMessage).toBe(false)
  })

  it('should identify reply message', () => {
    const message = createMessage({ parentId: 'parent-msg' })
    const { result } = renderHook(() => useMessageRenderer(message))

    expect(result.current.isReply).toBe(true)
  })

  it('should identify streaming message', () => {
    const message = createMessage({ streaming: true })
    const { result } = renderHook(() => useMessageRenderer(message))

    expect(result.current.isStreaming).toBe(true)
  })

  it('should provide content props for text', () => {
    const message = createMessage()
    const { result } = renderHook(() => useMessageRenderer(message))

    expect(result.current.content.type).toBe('text')
    expect(result.current.content.text).toBe('Hello world')
    expect(result.current.content.hasText).toBe(true)
    expect(result.current.content.hasMedia).toBe(false)
  })

  it('should provide content props for image', () => {
    const message = createMessage({
      content: {
        type: 'image',
        uri: 'https://example.com/photo.jpg',
        thumbnail: 'https://example.com/thumb.jpg',
      },
    })
    const { result } = renderHook(() => useMessageRenderer(message))

    expect(result.current.content.type).toBe('image')
    expect(result.current.content.hasMedia).toBe(true)
    expect(result.current.content.thumbnail).toBe('https://example.com/thumb.jpg')
  })

  it('should provide delivery status info', () => {
    const message = createMessage({ deliveryStatus: 'delivered' })
    const { result } = renderHook(() => useMessageRenderer(message))

    expect(result.current.deliveryStatus.status).toBe('delivered')
    expect(result.current.deliveryStatus.label).toBe('Delivered')
    expect(result.current.deliveryStatus.icon).toBe('delivered')
  })

  it('should format timestamp', () => {
    const now = new Date()
    const message = createMessage({ createdAt: now.toISOString() })
    const { result } = renderHook(() => useMessageRenderer(message))

    expect(result.current.timestamp).toBe('now')
  })

  it('should group attachments by type', () => {
    const message = createMessage({
      attachments: [
        createAttachment({ id: 'img-1', type: 'image' }),
        createAttachment({ id: 'img-2', type: 'image' }),
        createAttachment({ id: 'vid-1', type: 'video', fileName: 'video.mp4', mimeType: 'video/mp4' }),
        createAttachment({ id: 'file-1', type: 'file', fileName: 'doc.pdf', mimeType: 'application/pdf' }),
      ],
    })
    const { result } = renderHook(() => useMessageRenderer(message))

    expect(result.current.attachments.count).toBe(4)
    expect(result.current.attachments.byType.images).toHaveLength(2)
    expect(result.current.attachments.byType.videos).toHaveLength(1)
    expect(result.current.attachments.byType.files).toHaveLength(1)
  })

  it('should sort reactions by count', () => {
    const message = createMessage({
      reactions: [
        { emoji: '👍', userIds: ['a'], count: 1 },
        { emoji: '❤️', userIds: ['a', 'b', 'c'], count: 3 },
        { emoji: '😂', userIds: ['a', 'b'], count: 2 },
      ],
    })
    const { result } = renderHook(() => useMessageRenderer(message))

    expect(result.current.reactions.sorted[0].emoji).toBe('❤️')
    expect(result.current.reactions.sorted[1].emoji).toBe('😂')
    expect(result.current.reactions.totalCount).toBe(6)
  })

  it('should check if user has reacted', () => {
    const message = createMessage({
      reactions: [{ emoji: '👍', userIds: ['user-1', 'user-2'], count: 2 }],
    })
    const { result } = renderHook(() => useMessageRenderer(message))

    expect(result.current.reactions.hasUserReacted('👍', 'user-1')).toBe(true)
    expect(result.current.reactions.hasUserReacted('👍', 'user-3')).toBe(false)
    expect(result.current.reactions.hasUserReacted('❤️', 'user-1')).toBe(false)
  })
})

describe('MessageRenderer', () => {
  it('should render with render props', () => {
    const message = createMessage()
    let renderPropsReceived = false

    create(
      <MessageRenderer message={message} currentUserId="me">
        {(props) => {
          renderPropsReceived = true
          expect(props.message).toBe(message)
          expect(props.content.text).toBe('Hello world')
          return null
        }}
      </MessageRenderer>
    )

    expect(renderPropsReceived).toBe(true)
  })
})

// ─── AttachmentRenderer Tests ───────────────────────────────────────────────

describe('useAttachmentRenderer', () => {
  it('should identify image attachment', () => {
    const attachment = createAttachment({ type: 'image' })
    const { result } = renderHook(() => useAttachmentRenderer(attachment))

    expect(result.current.isImage).toBe(true)
    expect(result.current.isVideo).toBe(false)
    expect(result.current.isAudio).toBe(false)
    expect(result.current.isFile).toBe(false)
  })

  it('should identify video attachment', () => {
    const attachment = createAttachment({ type: 'video', mimeType: 'video/mp4' })
    const { result } = renderHook(() => useAttachmentRenderer(attachment))

    expect(result.current.isVideo).toBe(true)
  })

  it('should format file size', () => {
    const attachment = createAttachment({ size: 1024 * 1024 * 2.5 }) // 2.5MB
    const { result } = renderHook(() => useAttachmentRenderer(attachment))

    expect(result.current.fileSize).toBe('2.5 MB')
  })

  it('should format duration', () => {
    const attachment = createAttachment({
      type: 'audio',
      mimeType: 'audio/mp3',
      duration: 125, // 2:05
    })
    const { result } = renderHook(() => useAttachmentRenderer(attachment))

    expect(result.current.duration).toBe('2:05')
  })

  it('should format long duration', () => {
    const attachment = createAttachment({
      type: 'video',
      mimeType: 'video/mp4',
      duration: 3725, // 1:02:05
    })
    const { result } = renderHook(() => useAttachmentRenderer(attachment))

    expect(result.current.duration).toBe('1:02:05')
  })

  it('should extract file extension', () => {
    const attachment = createAttachment({ fileName: 'document.pdf' })
    const { result } = renderHook(() => useAttachmentRenderer(attachment))

    expect(result.current.extension).toBe('pdf')
  })

  it('should determine mime category', () => {
    const pdfAttachment = createAttachment({
      type: 'file',
      mimeType: 'application/pdf',
      fileName: 'doc.pdf',
    })
    const { result: pdfResult } = renderHook(() =>
      useAttachmentRenderer(pdfAttachment)
    )
    expect(pdfResult.current.mimeCategory).toBe('pdf')

    const docAttachment = createAttachment({
      type: 'file',
      mimeType: 'application/msword',
      fileName: 'doc.doc',
    })
    const { result: docResult } = renderHook(() =>
      useAttachmentRenderer(docAttachment)
    )
    expect(docResult.current.mimeCategory).toBe('document')
  })

  it('should track loading state', () => {
    const attachment = createAttachment()
    const { result } = renderHook(() =>
      useAttachmentRenderer(attachment, { isLoading: true, progress: 50 })
    )

    expect(result.current.isLoading).toBe(true)
    expect(result.current.progress).toBe(50)
  })

  it('should provide icon name', () => {
    const imageAtt = createAttachment({ type: 'image' })
    const { result: imgResult } = renderHook(() =>
      useAttachmentRenderer(imageAtt)
    )
    expect(imgResult.current.iconName).toBe('image')

    const pdfAtt = createAttachment({
      type: 'file',
      mimeType: 'application/pdf',
      fileName: 'doc.pdf',
    })
    const { result: pdfResult } = renderHook(() => useAttachmentRenderer(pdfAtt))
    expect(pdfResult.current.iconName).toBe('file-pdf')
  })
})

describe('AttachmentRenderer', () => {
  it('should render with render props', () => {
    const attachment = createAttachment()
    let renderPropsReceived = false

    create(
      <AttachmentRenderer attachment={attachment}>
        {(props) => {
          renderPropsReceived = true
          expect(props.attachment).toBe(attachment)
          expect(props.isImage).toBe(true)
          return null
        }}
      </AttachmentRenderer>
    )

    expect(renderPropsReceived).toBe(true)
  })
})

// ─── ReactionPicker Tests ───────────────────────────────────────────────────

describe('useReactionPicker', () => {
  const reactions: Reaction[] = [
    { emoji: '👍', userIds: ['user-1', 'user-2'], count: 2 },
    { emoji: '❤️', userIds: ['user-1'], count: 1 },
  ]

  it('should provide quick reactions with selection state', () => {
    const { result } = renderHook(() =>
      useReactionPicker({
        reactions,
        currentUserId: 'user-1',
        onReactionToggle: jest.fn(),
        quickReactions: ['👍', '❤️', '😂'],
      })
    )

    expect(result.current.quickReactions).toHaveLength(3)
    expect(result.current.quickReactions[0]).toEqual({
      emoji: '👍',
      isSelected: true,
      count: 2,
    })
    expect(result.current.quickReactions[2]).toEqual({
      emoji: '😂',
      isSelected: false,
      count: 0,
    })
  })

  it('should provide current reactions with own state', () => {
    const { result } = renderHook(() =>
      useReactionPicker({
        reactions,
        currentUserId: 'user-2',
        onReactionToggle: jest.fn(),
      })
    )

    expect(result.current.currentReactions).toHaveLength(2)
    expect(result.current.currentReactions[0].isOwnReaction).toBe(true) // 👍
    expect(result.current.currentReactions[1].isOwnReaction).toBe(false) // ❤️
  })

  it('should call onReactionToggle when toggling', () => {
    const onToggle = jest.fn()
    const { result } = renderHook(() =>
      useReactionPicker({
        reactions: [],
        currentUserId: 'user-1',
        onReactionToggle: onToggle,
      })
    )

    act(() => {
      result.current.toggleReaction('👍')
    })

    expect(onToggle).toHaveBeenCalledWith('👍')
  })

  it('should toggle full picker state', () => {
    const onToggleFullPicker = jest.fn()
    const { result } = renderHook(() =>
      useReactionPicker({
        reactions: [],
        currentUserId: 'user-1',
        onReactionToggle: jest.fn(),
        onToggleFullPicker,
      })
    )

    expect(result.current.isFullPickerOpen).toBe(false)

    act(() => {
      result.current.openFullPicker()
    })
    expect(result.current.isFullPickerOpen).toBe(true)
    expect(onToggleFullPicker).toHaveBeenCalledWith(true)

    act(() => {
      result.current.closeFullPicker()
    })
    expect(result.current.isFullPickerOpen).toBe(false)
    expect(onToggleFullPicker).toHaveBeenCalledWith(false)
  })

  it('should provide total reaction count', () => {
    const { result } = renderHook(() =>
      useReactionPicker({
        reactions,
        currentUserId: 'user-1',
        onReactionToggle: jest.fn(),
      })
    )

    expect(result.current.totalReactionCount).toBe(3)
    expect(result.current.uniqueEmojiCount).toBe(2)
  })

  it('should use default quick reactions when not provided', () => {
    const { result } = renderHook(() =>
      useReactionPicker({
        reactions: [],
        currentUserId: 'user-1',
        onReactionToggle: jest.fn(),
      })
    )

    expect(result.current.quickReactions.length).toBeGreaterThan(0)
    expect(result.current.quickReactions[0].emoji).toBe('👍')
  })
})

describe('ReactionPicker', () => {
  it('should render with render props', () => {
    let renderPropsReceived = false

    create(
      <ReactionPicker
        currentUserId="user-1"
        onReactionToggle={jest.fn()}
      >
        {(props) => {
          renderPropsReceived = true
          expect(props.toggleReaction).toBeDefined()
          expect(props.quickReactions).toBeDefined()
          return null
        }}
      </ReactionPicker>
    )

    expect(renderPropsReceived).toBe(true)
  })
})
