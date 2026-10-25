const preset = require('../../jest.preset')

/** @type {import('ts-jest').JestConfigWithTsJest} */
module.exports = {
  ...preset,
  displayName: 'auth',
  roots: ['<rootDir>/src'],
  testMatch: ['**/__tests__/**/*.test.ts', '**/__tests__/**/*.test.tsx'],
  moduleNameMapper: {
    '^expo-secure-store$': '<rootDir>/__mocks__/expo-secure-store.ts',
    '^expo-local-authentication$': '<rootDir>/__mocks__/expo-local-authentication.ts',
    '^@mongrov/core$': '<rootDir>/__mocks__/@mongrov/core.ts',
    '^jwt-decode$': '<rootDir>/__mocks__/jwt-decode.ts',
  },
}
