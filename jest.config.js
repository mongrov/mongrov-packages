/** @type {import('ts-jest').JestConfigWithTsJest} */
module.exports = {
  preset: 'ts-jest',
  testEnvironment: 'node',
  roots: ['<rootDir>/src'],
  testMatch: ['**/__tests__/**/*.test.ts', '**/__tests__/**/*.test.tsx'],
  moduleFileExtensions: ['ts', 'tsx', 'js', 'jsx', 'json'],
  transform: {
    '^.+\\.tsx?$': [
      'ts-jest',
      {
        tsconfig: 'tsconfig.json',
      },
    ],
  },
  moduleNameMapper: {
    '^expo-file-system$': '<rootDir>/__mocks__/expo-file-system.ts',
    '^expo-network$': '<rootDir>/__mocks__/expo-network.ts',
    '^react-native-mmkv$': '<rootDir>/__mocks__/react-native-mmkv.ts',
    '^expo-router$': '<rootDir>/__mocks__/expo-router.ts',
  },
  collectCoverageFrom: [
    'src/**/*.{ts,tsx}',
    '!src/**/__tests__/**',
    '!src/index.ts',
  ],
  coverageThreshold: {
    global: {
      branches: 70,
      functions: 80,
      lines: 80,
      statements: 80,
    },
  },
};
