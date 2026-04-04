/**
 * ReactionPicker - Headless emoji reaction picker component
 *
 * Provides render props and handlers for emoji reactions.
 * App provides the actual UI components.
 */

import { useState, useMemo, useCallback, type ReactNode } from 'react'
import type { Reaction } from '@mongrov/types'

// ─── Types ──────────────────────────────────────────────────────────────────

export interface ReactionPickerProps {
  /** Current reactions on the message */
  reactions?: Reaction[]
  /** Current user ID */
  currentUserId: string
  /** Callback when user toggles a reaction */
  onReactionToggle: (emoji: string) => void
  /** Available quick reactions (shown first) */
  quickReactions?: string[]
  /** Whether to show the full emoji picker */
  showFullPicker?: boolean
  /** Callback when full picker is toggled */
  onToggleFullPicker?: (show: boolean) => void
  /** Render function */
  children: (renderProps: ReactionPickerRenderProps) => ReactNode
}

export interface ReactionPickerRenderProps {
  /** Quick reaction emojis */
  quickReactions: QuickReactionItem[]
  /** Current reactions with user state */
  currentReactions: CurrentReactionItem[]
  /** Toggle a reaction */
  toggleReaction: (emoji: string) => void
  /** Whether full picker is shown */
  isFullPickerOpen: boolean
  /** Open full emoji picker */
  openFullPicker: () => void
  /** Close full emoji picker */
  closeFullPicker: () => void
  /** Toggle full emoji picker */
  toggleFullPicker: () => void
  /** Total unique emojis used */
  uniqueEmojiCount: number
  /** Total reaction count */
  totalReactionCount: number
}

export interface QuickReactionItem {
  emoji: string
  /** Whether current user has used this reaction */
  isSelected: boolean
  /** Number of users who used this reaction */
  count: number
}

export interface CurrentReactionItem {
  emoji: string
  /** Number of users who used this reaction */
  count: number
  /** User IDs who reacted */
  userIds: string[]
  /** Whether current user has used this reaction */
  isOwnReaction: boolean
}

// ─── Default Quick Reactions ────────────────────────────────────────────────

const DEFAULT_QUICK_REACTIONS = [
  '\u{1F44D}', // thumbs up
  '\u{2764}\u{FE0F}', // red heart
  '\u{1F602}', // face with tears of joy
  '\u{1F62E}', // face with open mouth
  '\u{1F622}', // crying face
  '\u{1F64F}', // folded hands
]

// ─── Hook ───────────────────────────────────────────────────────────────────

export interface UseReactionPickerOptions {
  reactions?: Reaction[]
  currentUserId: string
  onReactionToggle: (emoji: string) => void
  quickReactions?: string[]
  initialFullPickerOpen?: boolean
  onToggleFullPicker?: (show: boolean) => void
}

/**
 * Hook for reaction picker logic.
 * Use this when you need the render props outside of ReactionPicker.
 */
export function useReactionPicker(
  options: UseReactionPickerOptions
): ReactionPickerRenderProps {
  const {
    reactions = [],
    currentUserId,
    onReactionToggle,
    quickReactions = DEFAULT_QUICK_REACTIONS,
    initialFullPickerOpen = false,
    onToggleFullPicker,
  } = options

  const [isFullPickerOpen, setIsFullPickerOpen] = useState(initialFullPickerOpen)

  // Build reaction lookup map
  const reactionMap = useMemo(() => {
    const map = new Map<string, Reaction>()
    for (const reaction of reactions) {
      map.set(reaction.emoji, reaction)
    }
    return map
  }, [reactions])

  // Quick reactions with selection state
  const quickReactionItems = useMemo<QuickReactionItem[]>(() => {
    return quickReactions.map((emoji) => {
      const reaction = reactionMap.get(emoji)
      return {
        emoji,
        isSelected: reaction?.userIds.includes(currentUserId) ?? false,
        count: reaction?.count ?? 0,
      }
    })
  }, [quickReactions, reactionMap, currentUserId])

  // Current reactions with user state
  const currentReactionItems = useMemo<CurrentReactionItem[]>(() => {
    return reactions.map((reaction) => ({
      emoji: reaction.emoji,
      count: reaction.count,
      userIds: reaction.userIds,
      isOwnReaction: reaction.userIds.includes(currentUserId),
    }))
  }, [reactions, currentUserId])

  const toggleReaction = useCallback(
    (emoji: string) => {
      onReactionToggle(emoji)
    },
    [onReactionToggle]
  )

  const openFullPicker = useCallback(() => {
    setIsFullPickerOpen(true)
    onToggleFullPicker?.(true)
  }, [onToggleFullPicker])

  const closeFullPicker = useCallback(() => {
    setIsFullPickerOpen(false)
    onToggleFullPicker?.(false)
  }, [onToggleFullPicker])

  const toggleFullPicker = useCallback(() => {
    const newState = !isFullPickerOpen
    setIsFullPickerOpen(newState)
    onToggleFullPicker?.(newState)
  }, [isFullPickerOpen, onToggleFullPicker])

  const totalReactionCount = useMemo(() => {
    return reactions.reduce((sum, r) => sum + r.count, 0)
  }, [reactions])

  return {
    quickReactions: quickReactionItems,
    currentReactions: currentReactionItems,
    toggleReaction,
    isFullPickerOpen,
    openFullPicker,
    closeFullPicker,
    toggleFullPicker,
    uniqueEmojiCount: reactions.length,
    totalReactionCount,
  }
}

// ─── Component ──────────────────────────────────────────────────────────────

/**
 * Headless reaction picker component.
 *
 * @example
 * ```tsx
 * <ReactionPicker
 *   reactions={message.reactions}
 *   currentUserId={userId}
 *   onReactionToggle={handleReactionToggle}
 * >
 *   {({ quickReactions, toggleReaction, toggleFullPicker }) => (
 *     <View style={styles.reactionBar}>
 *       {quickReactions.map(({ emoji, isSelected, count }) => (
 *         <Pressable
 *           key={emoji}
 *           onPress={() => toggleReaction(emoji)}
 *           style={isSelected ? styles.selected : styles.normal}
 *         >
 *           <Text>{emoji}</Text>
 *           {count > 0 && <Text>{count}</Text>}
 *         </Pressable>
 *       ))}
 *       <Pressable onPress={toggleFullPicker}>
 *         <Text>+</Text>
 *       </Pressable>
 *     </View>
 *   )}
 * </ReactionPicker>
 * ```
 */
export function ReactionPicker({
  reactions,
  currentUserId,
  onReactionToggle,
  quickReactions,
  showFullPicker,
  onToggleFullPicker,
  children,
}: ReactionPickerProps): ReactNode {
  const renderProps = useReactionPicker({
    reactions,
    currentUserId,
    onReactionToggle,
    quickReactions,
    initialFullPickerOpen: showFullPicker,
    onToggleFullPicker,
  })

  return children(renderProps)
}

// ─── Utility Functions ──────────────────────────────────────────────────────

/**
 * Common emoji categories for building a full picker.
 */
export const EMOJI_CATEGORIES = {
  smileys: [
    '\u{1F600}', '\u{1F603}', '\u{1F604}', '\u{1F601}', '\u{1F606}', '\u{1F605}',
    '\u{1F602}', '\u{1F923}', '\u{1F642}', '\u{1F643}', '\u{1F609}', '\u{1F60A}',
    '\u{1F60B}', '\u{1F60D}', '\u{1F970}', '\u{1F618}', '\u{1F617}', '\u{1F619}',
  ],
  gestures: [
    '\u{1F44D}', '\u{1F44E}', '\u{1F44C}', '\u{1F44A}', '\u{270A}', '\u{1F91B}',
    '\u{1F91C}', '\u{1F44F}', '\u{1F64C}', '\u{1F450}', '\u{1F64F}', '\u{1F91D}',
  ],
  hearts: [
    '\u{2764}\u{FE0F}', '\u{1F9E1}', '\u{1F49B}', '\u{1F49A}', '\u{1F499}',
    '\u{1F49C}', '\u{1F5A4}', '\u{1F90D}', '\u{1F90E}', '\u{1F495}', '\u{1F496}',
  ],
  objects: [
    '\u{1F389}', '\u{1F38A}', '\u{1F381}', '\u{1F3C6}', '\u{1F4A1}', '\u{1F4DD}',
    '\u{1F4DA}', '\u{1F4E7}', '\u{1F4F1}', '\u{1F4BB}', '\u{1F5C3}', '\u{1F4C1}',
  ],
} as const
