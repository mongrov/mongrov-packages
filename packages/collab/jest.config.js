const preset = require('../../jest.preset')

module.exports = {
  ...preset,
  displayName: 'collab',
  roots: ['<rootDir>/src'],
  testMatch: ['**/__tests__/**/*.test.ts?(x)'],
  testEnvironment: 'jsdom',
  coverageThreshold: {
    global: {
      branches: 30,
      functions: 15,
      lines: 15,
      statements: 15,
    },
  },
  // Provider and hooks require full React rendering tests (added in app integration)
  // RocketChat adapter is intentionally a stub for app to extend
  coveragePathIgnorePatterns: [
    '/node_modules/',
    '/adapters/rocketchat/',
  ],
}
