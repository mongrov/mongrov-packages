/**
 * React hooks for RxDB database access
 *
 * Provides context-based database injection and reactive query hooks.
 */

import {
  createContext,
  useContext,
  useState,
  useEffect,
  useCallback,
  useMemo,
  type ReactNode,
} from 'react'

import type {
  RxDatabaseType,
  RxCollectionType,
  RxDocumentType,
  MangoQueryType,
} from './types'

// ─── Context ────────────────────────────────────────────────────────────────

interface DatabaseContextValue {
  db: RxDatabaseType | null
  isReady: boolean
}

const DatabaseContext = createContext<DatabaseContextValue | null>(null)

// ─── Provider ───────────────────────────────────────────────────────────────

export interface DatabaseProviderProps {
  /** The RxDB database instance (can be null during initialization) */
  database: RxDatabaseType | null
  /** Child components */
  children: ReactNode
}

/**
 * Provides database context to child components.
 *
 * @example
 * ```tsx
 * function App() {
 *   const [db, setDb] = useState<RxDatabase | null>(null)
 *
 *   useEffect(() => {
 *     createDatabase(config).then(setDb)
 *   }, [])
 *
 *   return (
 *     <DatabaseProvider database={db}>
 *       <MyApp />
 *     </DatabaseProvider>
 *   )
 * }
 * ```
 */
export function DatabaseProvider({ database, children }: DatabaseProviderProps): ReactNode {
  const value = useMemo<DatabaseContextValue>(
    () => ({
      db: database,
      isReady: database !== null,
    }),
    [database]
  )

  return <DatabaseContext.Provider value={value}>{children}</DatabaseContext.Provider>
}

// ─── Hooks ──────────────────────────────────────────────────────────────────

/**
 * Hook to access the database context.
 *
 * @returns The database context value
 * @throws If used outside of DatabaseProvider
 */
export function useDatabase(): DatabaseContextValue {
  const context = useContext(DatabaseContext)
  if (context === null) {
    throw new Error(
      '[useDatabase] Hook called outside of DatabaseProvider.\n\n' +
      'To fix this, wrap your component tree with DatabaseProvider:\n\n' +
      '  import { DatabaseProvider, createDatabase } from "@mongrov/db"\n\n' +
      '  function App() {\n' +
      '    const [db, setDb] = useState(null)\n' +
      '    useEffect(() => { createDatabase(config).then(setDb) }, [])\n\n' +
      '    return (\n' +
      '      <DatabaseProvider database={db}>\n' +
      '        <YourComponent />\n' +
      '      </DatabaseProvider>\n' +
      '    )\n' +
      '  }'
    )
  }
  return context
}

/**
 * Hook to access a specific collection.
 *
 * @param name - Collection name
 * @returns The collection instance or null if not ready
 *
 * @example
 * ```tsx
 * function MessageList() {
 *   const messages = useCollection('messages')
 *
 *   if (!messages) return <Loading />
 *
 *   // Use messages collection...
 * }
 * ```
 */
export function useCollection<T = RxCollectionType>(name: string): T | null {
  const { db, isReady } = useDatabase()

  if (!isReady || !db) {
    return null
  }

  return db[name] as T | undefined ?? null
}

/**
 * Query result state.
 */
export interface QueryResult<T> {
  /** The query results (empty array while loading) */
  data: T[]
  /** Whether the query is currently loading */
  isLoading: boolean
  /** Error if the query failed */
  error: Error | null
  /** Re-execute the query */
  refetch: () => void
}

/**
 * Hook to execute a reactive query on a collection.
 *
 * @param collectionName - Name of the collection to query
 * @param query - RxDB/Mango query selector
 * @returns Query result with reactive updates
 *
 * @example
 * ```tsx
 * function RecentMessages() {
 *   const { data, isLoading, error } = useQuery('messages', {
 *     selector: { createdAt: { $gt: Date.now() - 86400000 } },
 *     sort: [{ createdAt: 'desc' }],
 *     limit: 50,
 *   })
 *
 *   if (isLoading) return <Loading />
 *   if (error) return <Error message={error.message} />
 *
 *   return <MessageList messages={data} />
 * }
 * ```
 */
export function useQuery<T = RxDocumentType>(
  collectionName: string,
  query: MangoQueryType = {}
): QueryResult<T> {
  const collection = useCollection(collectionName)
  const [data, setData] = useState<T[]>([])
  const [isLoading, setIsLoading] = useState(true)
  const [error, setError] = useState<Error | null>(null)
  const [refetchTrigger, setRefetchTrigger] = useState(0)

  // Memoize query to prevent infinite re-subscriptions
  const queryKey = useMemo(() => JSON.stringify(query), [query])

  const refetch = useCallback(() => {
    setRefetchTrigger(prev => prev + 1)
  }, [])

  useEffect(() => {
    if (!collection) {
      setIsLoading(true)
      setData([])
      return
    }

    setIsLoading(true)
    setError(null)

    let subscription: { unsubscribe: () => void } | null = null

    try {
      const parsedQuery = JSON.parse(queryKey)
      const rxQuery = collection.find(parsedQuery)

      subscription = rxQuery.$.subscribe({
        next: (results: RxDocumentType[]) => {
          // Convert RxDocuments to plain objects
          const plainData = results.map((doc: RxDocumentType) =>
            typeof doc.toJSON === 'function' ? doc.toJSON() : doc
          ) as T[]
          setData(plainData)
          setIsLoading(false)
        },
        error: (err: Error) => {
          setError(err)
          setIsLoading(false)
        },
      })
    } catch (err) {
      setError(err instanceof Error ? err : new Error(String(err)))
      setIsLoading(false)
    }

    return () => {
      subscription?.unsubscribe()
    }
  }, [collection, queryKey, refetchTrigger])

  return { data, isLoading, error, refetch }
}

/**
 * Document result state.
 */
export interface DocumentResult<T> {
  /** The document data or null if not found */
  data: T | null
  /** Whether the document is currently loading */
  isLoading: boolean
  /** Error if the fetch failed */
  error: Error | null
  /** Re-fetch the document */
  refetch: () => void
}

/**
 * Hook to fetch and subscribe to a single document by ID.
 *
 * @param collectionName - Name of the collection
 * @param id - Document primary key
 * @returns Document result with reactive updates
 *
 * @example
 * ```tsx
 * function MessageDetail({ messageId }: { messageId: string }) {
 *   const { data: message, isLoading, error } = useDocument('messages', messageId)
 *
 *   if (isLoading) return <Loading />
 *   if (error) return <Error message={error.message} />
 *   if (!message) return <NotFound />
 *
 *   return <MessageView message={message} />
 * }
 * ```
 */
export function useDocument<T = RxDocumentType>(
  collectionName: string,
  id: string | null | undefined
): DocumentResult<T> {
  const collection = useCollection(collectionName)
  const [data, setData] = useState<T | null>(null)
  const [isLoading, setIsLoading] = useState(true)
  const [error, setError] = useState<Error | null>(null)
  const [refetchTrigger, setRefetchTrigger] = useState(0)

  const refetch = useCallback(() => {
    setRefetchTrigger(prev => prev + 1)
  }, [])

  useEffect(() => {
    if (!collection || !id) {
      setIsLoading(false)
      setData(null)
      return
    }

    setIsLoading(true)
    setError(null)

    let subscription: { unsubscribe: () => void } | null = null

    try {
      const doc$ = collection.findOne(id).$

      subscription = doc$.subscribe({
        next: (doc: RxDocumentType | null) => {
          if (doc) {
            const plainData = typeof doc.toJSON === 'function' ? doc.toJSON() : doc
            setData(plainData as T)
          } else {
            setData(null)
          }
          setIsLoading(false)
        },
        error: (err: Error) => {
          setError(err)
          setIsLoading(false)
        },
      })
    } catch (err) {
      setError(err instanceof Error ? err : new Error(String(err)))
      setIsLoading(false)
    }

    return () => {
      subscription?.unsubscribe()
    }
  }, [collection, id, refetchTrigger])

  return { data, isLoading, error, refetch }
}
