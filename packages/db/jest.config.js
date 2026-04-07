const preset = require('../../jest.preset')

module.exports = {
  ...preset,
  displayName: 'db',
  roots: ['<rootDir>/src'],
  testMatch: ['**/__tests__/**/*.test.ts?(x)'],
  testEnvironment: 'jsdom',
  moduleNameMapper: {
    '^react-native-mmkv$': '<rootDir>/__mocks__/react-native-mmkv.ts',
    '^expo-secure-store$': '<rootDir>/__mocks__/expo-secure-store.ts',
    '^rxdb$': '<rootDir>/__mocks__/rxdb.ts',
    '^rxdb/plugins/migration-schema$': '<rootDir>/__mocks__/rxdb/plugins/migration-schema.ts',
    '^rxdb/plugins/replication$': '<rootDir>/__mocks__/rxdb/plugins/replication.ts',
  },
  coverageThreshold: {
    global: {
      branches: 70,
      functions: 79,
      lines: 80,
      statements: 80,
    },
  },
}
