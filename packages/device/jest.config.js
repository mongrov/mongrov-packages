const preset = require('../../jest.preset')

/** @type {import('ts-jest').JestConfigWithTsJest} */
module.exports = {
  ...preset,
  displayName: 'device',
  roots: ['<rootDir>/src'],
  testMatch: ['**/__tests__/**/*.test.ts'],
  testEnvironment: 'node',
  moduleNameMapper: {
    // `@mongrov/types` subpaths emit ESM and declare only `types` +
    // `import` conditions, so CJS jest cannot resolve them. Type-only
    // imports are erased and never hit this; `sync-events.test.ts` is the
    // first cross-package VALUE import from a types subpath.
    // Mapping to source keeps the test exercising the real shared contract.
    // Proper fix is dual CJS/ESM emit from @mongrov/types — see UPGRADING.
    '^@mongrov/types/(.*)$': '<rootDir>/../types/src/$1',
    '^@mongrov/types$': '<rootDir>/../types/src/index.ts',
  },
}
