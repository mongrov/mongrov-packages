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
};
