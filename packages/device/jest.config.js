const preset = require('../../jest.preset')

/** @type {import('ts-jest').JestConfigWithTsJest} */
module.exports = {
  ...preset,
  displayName: 'device',
  roots: ['<rootDir>/src'],
  testMatch: ['**/__tests__/**/*.test.ts'],
  testEnvironment: 'node',
}
