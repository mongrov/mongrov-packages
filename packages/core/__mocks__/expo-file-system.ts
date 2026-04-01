const mockFiles: Record<string, string> = {}

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
      .filter((p) => p.startsWith(dir))
      .map((p) => p.replace(dir, ''))
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
  // Expose for test manipulation
  __mockFiles: mockFiles,
}

export = ExpoFileSystem
