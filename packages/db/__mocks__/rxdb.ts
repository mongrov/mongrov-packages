/**
 * Mock for rxdb
 *
 * Provides in-memory implementation for testing.
 */

import { BehaviorSubject } from 'rxjs'

type DocumentData = Record<string, unknown>

// Store databases and their collections in memory
const databases = new Map<string, MockRxDatabase>()

interface MockRxDocument {
  _data: DocumentData
  get(key: string): unknown
  toJSON(): DocumentData
  remove(): Promise<void>
  update(data: Partial<DocumentData>): Promise<void>
}

interface MockRxQuery {
  $: BehaviorSubject<MockRxDocument[]>
  exec(): Promise<MockRxDocument[]>
}

interface MockRxCollection {
  name: string
  schema: Record<string, unknown>
  _documents: Map<string, DocumentData>
  _subject: BehaviorSubject<MockRxDocument[]>
  insert(doc: DocumentData): Promise<MockRxDocument>
  bulkInsert(docs: DocumentData[]): Promise<{ success: MockRxDocument[] }>
  upsert(doc: DocumentData): Promise<MockRxDocument>
  find(query?: Record<string, unknown>): MockRxQuery
  findOne(id: string): { $: BehaviorSubject<MockRxDocument | null> }
  remove(): Promise<void>
}

interface MockRxDatabase {
  name: string
  collections: Record<string, MockRxCollection>
  addCollections(configs: Record<string, { schema: Record<string, unknown> }>): Promise<Record<string, MockRxCollection>>
  destroy(): Promise<void>
  [key: string]: unknown
}

function createMockDocument(data: DocumentData, collection: MockRxCollection): MockRxDocument {
  return {
    _data: { ...data },
    get(key: string) {
      return this._data[key]
    },
    toJSON() {
      return { ...this._data }
    },
    async remove() {
      const primaryKey = getPrimaryKey(collection.schema)
      const id = data[primaryKey] as string
      collection._documents.delete(id)
      emitCollectionChange(collection)
    },
    async update(updateData: Partial<DocumentData>) {
      Object.assign(this._data, updateData)
      const primaryKey = getPrimaryKey(collection.schema)
      const id = this._data[primaryKey] as string
      collection._documents.set(id, this._data)
      emitCollectionChange(collection)
    },
  }
}

function getPrimaryKey(schema: Record<string, unknown>): string {
  return (schema.primaryKey as string) || 'id'
}

function emitCollectionChange(collection: MockRxCollection): void {
  const docs = Array.from(collection._documents.values()).map(data =>
    createMockDocument(data, collection)
  )
  collection._subject.next(docs)
}

function createMockCollection(name: string, schema: Record<string, unknown>): MockRxCollection {
  const documents = new Map<string, DocumentData>()
  const subject = new BehaviorSubject<MockRxDocument[]>([])

  const collection: MockRxCollection = {
    name,
    schema,
    _documents: documents,
    _subject: subject,

    async insert(doc: DocumentData) {
      const primaryKey = getPrimaryKey(schema)
      const id = doc[primaryKey] as string
      if (documents.has(id)) {
        throw new Error(`Document with id ${id} already exists`)
      }
      documents.set(id, { ...doc })
      emitCollectionChange(collection)
      return createMockDocument(doc, collection)
    },

    async bulkInsert(docs: DocumentData[]) {
      const results: MockRxDocument[] = []
      for (const doc of docs) {
        const primaryKey = getPrimaryKey(schema)
        const id = doc[primaryKey] as string
        documents.set(id, { ...doc })
        results.push(createMockDocument(doc, collection))
      }
      emitCollectionChange(collection)
      return { success: results }
    },

    async upsert(doc: DocumentData) {
      const primaryKey = getPrimaryKey(schema)
      const id = doc[primaryKey] as string
      documents.set(id, { ...doc })
      emitCollectionChange(collection)
      return createMockDocument(doc, collection)
    },

    find(query?: Record<string, unknown>) {
      // Simple selector matching
      const filterDocs = () => {
        let docs = Array.from(documents.values())

        if (query?.selector) {
          const selector = query.selector as Record<string, unknown>
          docs = docs.filter(doc => {
            return Object.entries(selector).every(([key, value]) => {
              if (typeof value === 'object' && value !== null) {
                // Handle operators like $gt, $lt, $eq
                const ops = value as Record<string, unknown>
                const docValue = doc[key]
                if ('$eq' in ops) return docValue === ops.$eq
                if ('$gt' in ops) return (docValue as number) > (ops.$gt as number)
                if ('$gte' in ops) return (docValue as number) >= (ops.$gte as number)
                if ('$lt' in ops) return (docValue as number) < (ops.$lt as number)
                if ('$lte' in ops) return (docValue as number) <= (ops.$lte as number)
                if ('$ne' in ops) return docValue !== ops.$ne
                return false
              }
              return doc[key] === value
            })
          })
        }

        // Apply limit
        if (query?.limit && typeof query.limit === 'number') {
          docs = docs.slice(0, query.limit)
        }

        return docs.map(data => createMockDocument(data, collection))
      }

      const initialDocs = filterDocs()
      const querySubject = new BehaviorSubject<MockRxDocument[]>(initialDocs)

      // Subscribe to collection changes
      subject.subscribe(() => {
        querySubject.next(filterDocs())
      })

      return {
        $: querySubject,
        async exec() {
          return filterDocs()
        },
      }
    },

    findOne(id: string) {
      const docSubject = new BehaviorSubject<MockRxDocument | null>(null)

      const updateDoc = () => {
        const data = documents.get(id)
        docSubject.next(data ? createMockDocument(data, collection) : null)
      }

      updateDoc()
      subject.subscribe(updateDoc)

      return { $: docSubject }
    },

    async remove() {
      documents.clear()
      emitCollectionChange(collection)
    },
  }

  return collection
}

function createMockDatabase(name: string): MockRxDatabase {
  const collections: Record<string, MockRxCollection> = {}

  const db: MockRxDatabase = {
    name,
    collections,

    async addCollections(configs: Record<string, { schema: Record<string, unknown> }>) {
      const added: Record<string, MockRxCollection> = {}

      for (const [colName, config] of Object.entries(configs)) {
        const collection = createMockCollection(colName, config.schema)
        collections[colName] = collection
        added[colName] = collection
        // Also add as direct property for convenience (db.messages syntax)
        ;(db as Record<string, unknown>)[colName] = collection
      }

      return added
    },

    async destroy() {
      for (const col of Object.values(collections)) {
        col._subject.complete()
      }
      databases.delete(name)
    },
  }

  return db
}

// ─── Exported Functions ─────────────────────────────────────────────────────

export async function createRxDatabase(config: {
  name: string
  storage: unknown
  multiInstance?: boolean
  ignoreDuplicate?: boolean
}): Promise<MockRxDatabase> {
  const { name, ignoreDuplicate = true } = config

  if (databases.has(name)) {
    if (ignoreDuplicate) {
      return databases.get(name)!
    }
    throw new Error(`Database with name ${name} already exists`)
  }

  const db = createMockDatabase(name)
  databases.set(name, db)
  return db
}

export function addRxPlugin(_plugin: unknown): void {
  // No-op for testing
}

// Helper to clear all databases between tests
export function __clearAllDatabases(): void {
  for (const db of databases.values()) {
    db.destroy()
  }
  databases.clear()
}
