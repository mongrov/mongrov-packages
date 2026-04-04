const preset = require('../../jest.preset')

module.exports = {
  ...preset,
  displayName: 'types',
  roots: ['<rootDir>/src'],
  testMatch: ['**/__tests__/**/*.test.ts'],
  testEnvironment: 'node',
  // Types package has no runtime code, only compile-time tests
  collectCoverageFrom: [],
  coverageThreshold: undefined,
}
