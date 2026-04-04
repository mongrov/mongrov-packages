/**
 * Tests for React hooks
 */

import React from 'react'
import { renderHook, act, waitFor } from '@testing-library/react'
import {
  DatabaseProvider,
  useDatabase,
  useCollection,
  useQuery,
  useDocument,
} from '../hooks'
import { createDatabase } from '../database'
import type { DatabaseConfig } from '../types'
import { __clearAllDatabases } from '../../__mocks__/rxdb'

// Sample schema for testing
const messageSchema = {
  version: 0,
  primaryKey: 'id',
  type: 'object',
  properties: {
    id: { type: 'string', maxLength: 100 },
    content: { type: 'string' },
    createdAt: { type: 'number' },
  },
  required: ['id', 'content'],
}

async function createTestDatabase(name: string) {
  const config: DatabaseConfig = {
    name,
    storage: {},
    collections: [{ name: 'messages', schema: messageSchema }],
  }
  return createDatabase(config)
}

describe('DatabaseProvider', () => {
  afterEach(async () => {
    __clearAllDatabases()
  })

  it('should provide database context to children', async () => {
    const db = await createTestDatabase('provider-test')

    const wrapper = ({ children }: { children: React.ReactNode }) => (
      <DatabaseProvider database={db}>{children}</DatabaseProvider>
    )

    const { result } = renderHook(() => useDatabase(), { wrapper })

    expect(result.current.db).toBe(db)
    expect(result.current.isReady).toBe(true)
  })

  it('should handle null database', () => {
    const wrapper = ({ children }: { children: React.ReactNode }) => (
      <DatabaseProvider database={null}>{children}</DatabaseProvider>
    )

    const { result } = renderHook(() => useDatabase(), { wrapper })

    expect(result.current.db).toBeNull()
    expect(result.current.isReady).toBe(false)
  })
})

describe('useDatabase', () => {
  it('should throw when used outside provider', () => {
    const { result } = renderHook(() => {
      try {
        return useDatabase()
      } catch (error) {
        return error
      }
    })

    expect(result.current).toBeInstanceOf(Error)
    expect((result.current as Error).message).toContain(
      '[useDatabase] Hook called outside of DatabaseProvider'
    )
  })
})

describe('useCollection', () => {
  afterEach(async () => {
    __clearAllDatabases()
  })

  it('should return collection when database is ready', async () => {
    const db = await createTestDatabase('collection-test')

    const wrapper = ({ children }: { children: React.ReactNode }) => (
      <DatabaseProvider database={db}>{children}</DatabaseProvider>
    )

    const { result } = renderHook(() => useCollection('messages'), { wrapper })

    expect(result.current).toBeDefined()
    expect(result.current?.name).toBe('messages')
  })

  it('should return null when database is not ready', () => {
    const wrapper = ({ children }: { children: React.ReactNode }) => (
      <DatabaseProvider database={null}>{children}</DatabaseProvider>
    )

    const { result } = renderHook(() => useCollection('messages'), { wrapper })

    expect(result.current).toBeNull()
  })

  it('should return null for non-existent collection', async () => {
    const db = await createTestDatabase('collection-missing-test')

    const wrapper = ({ children }: { children: React.ReactNode }) => (
      <DatabaseProvider database={db}>{children}</DatabaseProvider>
    )

    const { result } = renderHook(() => useCollection('nonexistent'), { wrapper })

    expect(result.current).toBeNull()
  })
})

describe('useQuery', () => {
  afterEach(async () => {
    __clearAllDatabases()
  })

  it('should return empty data initially', async () => {
    const db = await createTestDatabase('query-test')

    const wrapper = ({ children }: { children: React.ReactNode }) => (
      <DatabaseProvider database={db}>{children}</DatabaseProvider>
    )

    const { result } = renderHook(() => useQuery('messages'), { wrapper })

    await waitFor(() => {
      expect(result.current.isLoading).toBe(false)
    })

    expect(result.current.data).toEqual([])
    expect(result.current.error).toBeNull()
  })

  it('should return data after insert', async () => {
    const db = await createTestDatabase('query-insert-test')

    const wrapper = ({ children }: { children: React.ReactNode }) => (
      <DatabaseProvider database={db}>{children}</DatabaseProvider>
    )

    const { result } = renderHook(() => useQuery('messages'), { wrapper })

    // Insert a document
    await act(async () => {
      await db.messages.insert({
        id: 'msg-1',
        content: 'Hello World',
        createdAt: Date.now(),
      })
    })

    await waitFor(() => {
      expect(result.current.data.length).toBe(1)
    })

    expect(result.current.data[0]).toMatchObject({
      id: 'msg-1',
      content: 'Hello World',
    })
  })

  it('should filter data with selector', async () => {
    const db = await createTestDatabase('query-filter-test')

    // Insert multiple documents
    await db.messages.bulkInsert([
      { id: 'msg-1', content: 'First', createdAt: 100 },
      { id: 'msg-2', content: 'Second', createdAt: 200 },
      { id: 'msg-3', content: 'Third', createdAt: 300 },
    ])

    const wrapper = ({ children }: { children: React.ReactNode }) => (
      <DatabaseProvider database={db}>{children}</DatabaseProvider>
    )

    const { result } = renderHook(
      () =>
        useQuery('messages', {
          selector: { createdAt: { $gt: 150 } },
        }),
      { wrapper }
    )

    await waitFor(() => {
      expect(result.current.isLoading).toBe(false)
    })

    expect(result.current.data.length).toBe(2)
  })

  it('should support refetch', async () => {
    const db = await createTestDatabase('query-refetch-test')

    const wrapper = ({ children }: { children: React.ReactNode }) => (
      <DatabaseProvider database={db}>{children}</DatabaseProvider>
    )

    const { result } = renderHook(() => useQuery('messages'), { wrapper })

    await waitFor(() => {
      expect(result.current.isLoading).toBe(false)
    })

    // Insert a document
    await act(async () => {
      await db.messages.insert({
        id: 'msg-refetch',
        content: 'Refetch test',
        createdAt: Date.now(),
      })
    })

    // Refetch
    act(() => {
      result.current.refetch()
    })

    await waitFor(() => {
      expect(result.current.data.length).toBe(1)
    })
  })

  it('should return loading state when database not ready', () => {
    const wrapper = ({ children }: { children: React.ReactNode }) => (
      <DatabaseProvider database={null}>{children}</DatabaseProvider>
    )

    const { result } = renderHook(() => useQuery('messages'), { wrapper })

    expect(result.current.isLoading).toBe(true)
    expect(result.current.data).toEqual([])
  })
})

describe('useDocument', () => {
  afterEach(async () => {
    __clearAllDatabases()
  })

  it('should return null for non-existent document', async () => {
    const db = await createTestDatabase('doc-missing-test')

    const wrapper = ({ children }: { children: React.ReactNode }) => (
      <DatabaseProvider database={db}>{children}</DatabaseProvider>
    )

    const { result } = renderHook(() => useDocument('messages', 'non-existent'), {
      wrapper,
    })

    await waitFor(() => {
      expect(result.current.isLoading).toBe(false)
    })

    expect(result.current.data).toBeNull()
    expect(result.current.error).toBeNull()
  })

  it('should return document when it exists', async () => {
    const db = await createTestDatabase('doc-exists-test')

    // Insert a document first
    await db.messages.insert({
      id: 'msg-doc-1',
      content: 'Test document',
      createdAt: Date.now(),
    })

    const wrapper = ({ children }: { children: React.ReactNode }) => (
      <DatabaseProvider database={db}>{children}</DatabaseProvider>
    )

    const { result } = renderHook(() => useDocument('messages', 'msg-doc-1'), {
      wrapper,
    })

    await waitFor(() => {
      expect(result.current.isLoading).toBe(false)
    })

    expect(result.current.data).toMatchObject({
      id: 'msg-doc-1',
      content: 'Test document',
    })
  })

  it('should handle null id', async () => {
    const db = await createTestDatabase('doc-null-id-test')

    const wrapper = ({ children }: { children: React.ReactNode }) => (
      <DatabaseProvider database={db}>{children}</DatabaseProvider>
    )

    const { result } = renderHook(() => useDocument('messages', null), {
      wrapper,
    })

    expect(result.current.isLoading).toBe(false)
    expect(result.current.data).toBeNull()
  })

  it('should support refetch', async () => {
    const db = await createTestDatabase('doc-refetch-test')

    await db.messages.insert({
      id: 'msg-refetch-doc',
      content: 'Original',
      createdAt: Date.now(),
    })

    const wrapper = ({ children }: { children: React.ReactNode }) => (
      <DatabaseProvider database={db}>{children}</DatabaseProvider>
    )

    const { result } = renderHook(
      () => useDocument('messages', 'msg-refetch-doc'),
      { wrapper }
    )

    await waitFor(() => {
      expect(result.current.data).not.toBeNull()
    })

    expect(result.current.data?.content).toBe('Original')

    // Refetch should work
    act(() => {
      result.current.refetch()
    })

    await waitFor(() => {
      expect(result.current.isLoading).toBe(false)
    })

    expect(result.current.data).not.toBeNull()
  })
})
