const mockFiles: Record<string, string> = {}
// Set `noFileClass` to simulate expo-file-system before v19 (no `File`).
const mockState = { noFileClass: false, appends: 0 }

class MockFile {
  constructor(readonly uri: string) {}
  get exists(): boolean {
    return this.uri in mockFiles
  }

  create(): void {
    if (this.uri in mockFiles)
      throw new Error('already exists')
    mockFiles[this.uri] = ''
  }

  open() {
    const uri = this.uri
    if (!(uri in mockFiles))
      throw new Error('no such file')
    return {
      offset: 0 as number | null,
      get size() {
        return mockFiles[uri].length
      },
      writeBytes(bytes: Uint8Array) {
        const text = new TextDecoder().decode(bytes)
        const current = mockFiles[uri]
        const at = this.offset ?? 0
        mockFiles[uri] = current.slice(0, at) + text + current.slice(at + text.length)
        mockState.appends++
      },
      close() {},
    }
  }
}

const ExpoFileSystem = {
  documentDirectory: '/mock/documents/',
  writeAsStringAsync: jest.fn(async (path: string, contents: string) => {
    mockFiles[path] = contents
  }),
  readAsStringAsync: jest.fn(async (path: string) => {
    return mockFiles[path] ?? ''
  }),
  readDirectoryAsync: jest.fn(async (dir: string) => {
    return Object.keys(mockFiles)
      .filter(p => p.startsWith(dir))
      .map(p => p.replace(dir, ''))
  }),
  getInfoAsync: jest.fn(async (path: string) => {
    if (path.endsWith('/')) {
      return { exists: true, size: 0, isDirectory: true }
    }
    const exists = path in mockFiles
    return {
      exists,
      size: exists ? (mockFiles[path]?.length ?? 0) : 0,
      isDirectory: false,
    }
  }),
  deleteAsync: jest.fn(async (path: string) => {
    delete mockFiles[path]
  }),
  makeDirectoryAsync: jest.fn(async () => {}),
  EncodingType: { UTF8: 'utf8' },
  get File() {
    return mockState.noFileClass ? undefined : MockFile
  },
  get Paths() {
    return mockState.noFileClass ? undefined : { document: { uri: '/mock/documents/' } }
  },
  // Expose for test manipulation
  __mockFiles: mockFiles,
  __mockState: mockState,
}

export = ExpoFileSystem
