/**
 * AttachmentRenderer - Headless attachment rendering component
 *
 * Provides render props for different attachment types (image, video, audio, file).
 * App provides the actual UI components.
 */

import { useMemo, type ReactNode } from 'react'
import type { Attachment } from '@mongrov/types'

// ─── Types ──────────────────────────────────────────────────────────────────

export interface AttachmentRendererProps {
  /** The attachment to render */
  attachment: Attachment
  /** Optional: whether the attachment is loading */
  isLoading?: boolean
  /** Optional: download/upload progress (0-100) */
  progress?: number
  /** Optional: error message if failed */
  error?: string
  /** Render function for the attachment */
  children: (renderProps: AttachmentRenderProps) => ReactNode
}

export interface AttachmentRenderProps {
  /** The original attachment */
  attachment: Attachment
  /** Attachment type */
  type: Attachment['type']
  /** Display file name */
  fileName: string
  /** Formatted file size string */
  fileSize: string
  /** Formatted duration string (for audio/video) */
  duration?: string
  /** File extension */
  extension: string
  /** Whether this is an image */
  isImage: boolean
  /** Whether this is a video */
  isVideo: boolean
  /** Whether this is audio */
  isAudio: boolean
  /** Whether this is a generic file */
  isFile: boolean
  /** Whether it has a thumbnail preview */
  hasThumbnail: boolean
  /** Loading state */
  isLoading: boolean
  /** Progress percentage */
  progress: number
  /** Error message */
  error?: string
  /** Icon name suggestion based on type */
  iconName: string
  /** MIME type category */
  mimeCategory: MimeCategory
}

export type MimeCategory =
  | 'image'
  | 'video'
  | 'audio'
  | 'pdf'
  | 'document'
  | 'spreadsheet'
  | 'presentation'
  | 'archive'
  | 'code'
  | 'unknown'

// ─── Helpers ────────────────────────────────────────────────────────────────

function formatFileSize(bytes?: number): string {
  if (bytes === undefined || bytes === null) return ''

  const units = ['B', 'KB', 'MB', 'GB']
  let size = bytes
  let unitIndex = 0

  while (size >= 1024 && unitIndex < units.length - 1) {
    size /= 1024
    unitIndex++
  }

  return `${size.toFixed(unitIndex > 0 ? 1 : 0)} ${units[unitIndex]}`
}

function formatDuration(seconds?: number): string | undefined {
  if (seconds === undefined || seconds === null) return undefined

  const mins = Math.floor(seconds / 60)
  const secs = Math.floor(seconds % 60)

  if (mins >= 60) {
    const hours = Math.floor(mins / 60)
    const remainingMins = mins % 60
    return `${hours}:${remainingMins.toString().padStart(2, '0')}:${secs.toString().padStart(2, '0')}`
  }

  return `${mins}:${secs.toString().padStart(2, '0')}`
}

function getFileExtension(fileName: string): string {
  const parts = fileName.split('.')
  return parts.length > 1 ? parts[parts.length - 1].toLowerCase() : ''
}

function getMimeCategory(mimeType: string): MimeCategory {
  if (mimeType.startsWith('image/')) return 'image'
  if (mimeType.startsWith('video/')) return 'video'
  if (mimeType.startsWith('audio/')) return 'audio'
  if (mimeType === 'application/pdf') return 'pdf'

  if (
    mimeType.includes('document') ||
    mimeType.includes('msword') ||
    mimeType.includes('wordprocessing')
  ) {
    return 'document'
  }

  if (
    mimeType.includes('spreadsheet') ||
    mimeType.includes('excel') ||
    mimeType.includes('ms-excel')
  ) {
    return 'spreadsheet'
  }

  if (
    mimeType.includes('presentation') ||
    mimeType.includes('powerpoint') ||
    mimeType.includes('ms-powerpoint')
  ) {
    return 'presentation'
  }

  if (
    mimeType.includes('zip') ||
    mimeType.includes('rar') ||
    mimeType.includes('tar') ||
    mimeType.includes('gzip') ||
    mimeType.includes('7z')
  ) {
    return 'archive'
  }

  if (
    mimeType.includes('javascript') ||
    mimeType.includes('typescript') ||
    mimeType.includes('json') ||
    mimeType.includes('xml') ||
    mimeType.includes('html') ||
    mimeType.includes('css') ||
    mimeType === 'text/plain'
  ) {
    return 'code'
  }

  return 'unknown'
}

function getIconName(type: Attachment['type'], mimeCategory: MimeCategory): string {
  if (type === 'image') return 'image'
  if (type === 'video') return 'video'
  if (type === 'audio') return 'audio'

  // For files, use mime category
  const iconMap: Record<MimeCategory, string> = {
    image: 'image',
    video: 'video',
    audio: 'audio',
    pdf: 'file-pdf',
    document: 'file-text',
    spreadsheet: 'file-spreadsheet',
    presentation: 'file-presentation',
    archive: 'file-archive',
    code: 'file-code',
    unknown: 'file',
  }

  return iconMap[mimeCategory]
}

// ─── Hook ───────────────────────────────────────────────────────────────────

/**
 * Hook for attachment rendering logic.
 * Use this when you need the render props outside of AttachmentRenderer.
 */
export function useAttachmentRenderer(
  attachment: Attachment,
  options?: {
    isLoading?: boolean
    progress?: number
    error?: string
  }
): AttachmentRenderProps {
  return useMemo(() => {
    const { type, fileName, mimeType, size, duration, thumbnail } = attachment
    const { isLoading = false, progress = 0, error } = options ?? {}

    const extension = getFileExtension(fileName)
    const mimeCategory = getMimeCategory(mimeType)

    return {
      attachment,
      type,
      fileName,
      fileSize: formatFileSize(size),
      duration: formatDuration(duration),
      extension,
      isImage: type === 'image',
      isVideo: type === 'video',
      isAudio: type === 'audio',
      isFile: type === 'file',
      hasThumbnail: !!thumbnail,
      isLoading,
      progress,
      error,
      iconName: getIconName(type, mimeCategory),
      mimeCategory,
    }
  }, [attachment, options?.isLoading, options?.progress, options?.error])
}

// ─── Component ──────────────────────────────────────────────────────────────

/**
 * Headless attachment renderer component.
 *
 * @example
 * ```tsx
 * <AttachmentRenderer attachment={file} progress={uploadProgress}>
 *   {({ isImage, fileName, fileSize, hasThumbnail, progress }) => (
 *     <View>
 *       {isImage && hasThumbnail ? (
 *         <Image source={{ uri: file.thumbnail }} />
 *       ) : (
 *         <FileIcon name={iconName} />
 *       )}
 *       <Text>{fileName}</Text>
 *       <Text>{fileSize}</Text>
 *       {progress > 0 && progress < 100 && (
 *         <ProgressBar progress={progress} />
 *       )}
 *     </View>
 *   )}
 * </AttachmentRenderer>
 * ```
 */
export function AttachmentRenderer({
  attachment,
  isLoading,
  progress,
  error,
  children,
}: AttachmentRendererProps): ReactNode {
  const renderProps = useAttachmentRenderer(attachment, {
    isLoading,
    progress,
    error,
  })
  return children(renderProps)
}
