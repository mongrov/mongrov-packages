import {
  toGiftedMessage,
  fromGiftedMessage,
  toGiftedMessages,
  fromGiftedMessages,
} from '../ui/message-adapter';
import type { Message } from '../types';

describe('message-adapter', () => {
  const userMessage: Message = {
    id: 'msg-1',
    role: 'user',
    content: 'Hello',
    createdAt: new Date('2024-01-15T10:00:00Z'),
  };

  const assistantMessage: Message = {
    id: 'msg-2',
    role: 'assistant',
    content: 'Hi there!',
    createdAt: new Date('2024-01-15T10:00:01Z'),
  };

  describe('toGiftedMessage', () => {
    it('converts user message', () => {
      const result = toGiftedMessage(userMessage);
      expect(result._id).toBe('msg-1');
      expect(result.text).toBe('Hello');
      expect(result.user._id).toBe('user');
      expect(result.user.name).toBe('You');
    });

    it('converts assistant message', () => {
      const result = toGiftedMessage(assistantMessage);
      expect(result._id).toBe('msg-2');
      expect(result.text).toBe('Hi there!');
      expect(result.user._id).toBe('assistant');
      expect(result.user.name).toBe('Assistant');
    });

    it('uses custom config', () => {
      const result = toGiftedMessage(assistantMessage, {
        assistantName: 'AI Bot',
        assistantAvatar: 'https://example.com/avatar.png',
      });
      expect(result.user.name).toBe('AI Bot');
      expect(result.user.avatar).toBe('https://example.com/avatar.png');
    });

    it('handles missing createdAt', () => {
      const message = { ...userMessage, createdAt: undefined };
      const result = toGiftedMessage(message);
      expect(result.createdAt).toBeInstanceOf(Date);
    });
  });

  describe('fromGiftedMessage', () => {
    it('converts user gifted message', () => {
      const giftedMessage = {
        _id: 'gifted-1',
        text: 'Hello',
        createdAt: new Date('2024-01-15T10:00:00Z'),
        user: { _id: 'user', name: 'You' },
      };
      const result = fromGiftedMessage(giftedMessage);
      expect(result.id).toBe('gifted-1');
      expect(result.role).toBe('user');
      expect(result.content).toBe('Hello');
    });

    it('converts assistant gifted message', () => {
      const giftedMessage = {
        _id: 'gifted-2',
        text: 'Response',
        createdAt: new Date('2024-01-15T10:00:01Z'),
        user: { _id: 'assistant', name: 'Assistant' },
      };
      const result = fromGiftedMessage(giftedMessage);
      expect(result.role).toBe('assistant');
    });

    it('handles number createdAt', () => {
      const giftedMessage = {
        _id: 'gifted-3',
        text: 'Test',
        createdAt: 1705316400000,
        user: { _id: 'user' },
      };
      const result = fromGiftedMessage(giftedMessage);
      expect(result.createdAt).toBeInstanceOf(Date);
    });
  });

  describe('toGiftedMessages', () => {
    it('converts array and reverses order', () => {
      const messages = [userMessage, assistantMessage];
      const result = toGiftedMessages(messages);
      expect(result).toHaveLength(2);
      expect(result[0]._id).toBe('msg-2'); // Reversed - newest first
      expect(result[1]._id).toBe('msg-1');
    });

    it('handles empty array', () => {
      const result = toGiftedMessages([]);
      expect(result).toEqual([]);
    });
  });

  describe('fromGiftedMessages', () => {
    it('converts array and reverses order', () => {
      const giftedMessages = [
        {
          _id: 'g-2',
          text: 'B',
          createdAt: new Date(),
          user: { _id: 'assistant' },
        },
        {
          _id: 'g-1',
          text: 'A',
          createdAt: new Date(),
          user: { _id: 'user' },
        },
      ];
      const result = fromGiftedMessages(giftedMessages);
      expect(result).toHaveLength(2);
      expect(result[0].id).toBe('g-1'); // Reversed - oldest first
      expect(result[1].id).toBe('g-2');
    });
  });
});
