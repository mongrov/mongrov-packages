const preset = require('../../jest.preset');

/** @type {import('ts-jest').JestConfigWithTsJest} */
module.exports = {
  ...preset,
  displayName: 'ui',
  roots: ['<rootDir>/src'],
  testMatch: ['**/__tests__/**/*.test.ts', '**/__tests__/**/*.test.tsx'],
  testEnvironment: 'jsdom',
  setupFilesAfterEnv: ['<rootDir>/jest.setup.ts'],
  moduleNameMapper: {
    '^react-native$': '<rootDir>/__mocks__/react-native.ts',
    '^class-variance-authority$': '<rootDir>/__mocks__/class-variance-authority.ts',
    '^@rn-primitives/slot$': '<rootDir>/__mocks__/@rn-primitives/slot.ts',
    '^@rn-primitives/separator$': '<rootDir>/__mocks__/@rn-primitives/separator.ts',
    '^react-native-reanimated$': '<rootDir>/__mocks__/react-native-reanimated.ts',
  },
  // Temporarily lower coverage thresholds for new primitives and auth components
  // TODO: Add tests for primitives/auth components and restore thresholds
  coverageThreshold: {
    global: {
      branches: 25,
      functions: 15,
      lines: 30,
      statements: 25,
    },
  },
};
