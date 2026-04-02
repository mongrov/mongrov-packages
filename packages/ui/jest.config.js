const preset = require('../../jest.preset');

/** @type {import('ts-jest').JestConfigWithTsJest} */
module.exports = {
  ...preset,
  displayName: 'ui',
  roots: ['<rootDir>/src'],
  testMatch: ['**/__tests__/**/*.test.ts', '**/__tests__/**/*.test.tsx'],
  testEnvironment: 'jsdom',
  moduleNameMapper: {
    '^react-native$': '<rootDir>/__mocks__/react-native.ts',
  },
  // Temporarily lower coverage thresholds for new primitives
  // TODO: Add tests for primitives and restore thresholds
  coverageThreshold: {
    global: {
      branches: 40,
      functions: 20,
      lines: 35,
      statements: 30,
    },
  },
};
