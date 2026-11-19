# @mongrov packages

Shared npm packages for Mongrov React Native / Expo apps.

## Packages

| Package | Version | Description |
|---------|---------|-------------|
| [`@mongrov/types`](./packages/types) | 0.3.0 | Shared TypeScript type definitions |
| [`@mongrov/core`](./packages/core) | 0.4.0 | Structured logging framework |
| [`@mongrov/theme`](./packages/theme) | 0.3.0 | Theme contract and color scheme management |
| [`@mongrov/auth`](./packages/auth) | 0.5.1 | Auth lifecycle, token management, biometric, social auth |
| [`@mongrov/db`](./packages/db) | 0.2.3 | Database utilities (KVStore + RxDB) |
| [`@mongrov/collab`](./packages/collab) | 0.2.1 | Collaboration adapter for messaging |
| [`@mongrov/ui`](./packages/ui) | 0.4.1 | Shared UI primitives for React Native |
| [`@mongrov/ai`](./packages/ai) | 0.2.0 | AI chat hooks with XState integration |

## Installation

Each package can be installed individually:

```bash
npm install @mongrov/core @mongrov/types
# or
pnpm add @mongrov/core @mongrov/types
```

## Development

```bash
# Install dependencies
pnpm install

# Build all packages
pnpm run build

# Test all packages
pnpm run test

# Typecheck all packages
pnpm run typecheck
```

### Single Package Commands

```bash
# Test a specific package
pnpm --filter @mongrov/core run test

# Build a specific package
pnpm --filter @mongrov/core run build

# Watch tests for a package
pnpm --filter @mongrov/ui run test:watch
```

## Package Dependencies

```
@mongrov/types (base types - no dependencies)
    ↓
@mongrov/core (logging - depends on types)
    ↓
@mongrov/collab (collaboration - depends on types)

@mongrov/theme (theming - standalone)
@mongrov/db (database - standalone)
@mongrov/ui (UI components - standalone)
@mongrov/auth (authentication - standalone)
@mongrov/ai (AI chat - standalone)
```

## Publishing

Packages are published to npm using tag-based releases:

```bash
# 1. Update version in package.json
# 2. Update CHANGELOG.md
# 3. Create git tag
git tag @mongrov/core@0.4.0

# 4. Push tag to trigger GitHub Actions
git push origin @mongrov/core@0.4.0
```

For manual publishing:

```bash
cd packages/core
npm publish --access public
```

Every package's `prepublishOnly` builds it and then runs the domain-term
guard over exactly the files `npm pack` would publish
(`node ../../scripts/no-domain-terms.mjs --pack . --fail`). Publishing a
pre-built tarball (`npm publish x.tgz`) runs no lifecycle scripts, so check
it first: `node scripts/no-domain-terms.mjs --tarball x.tgz --fail`.
`pnpm release:check` builds everything and runs the guard over every
package's tarball contents plus the published-drift check.

## Domain-term guard

mongrov-packages is domain-free (techspec principle 73): no brand, vendor,
wearable or health term in anything a package ships. `scripts/no-domain-terms.mjs`
has two modes:

- **source** (`pnpm domain-terms`, part of `pnpm lint` and the pre-push hook):
  every file under `packages/*/` except `node_modules/` and `dist/` — code,
  SQL, docs, CHANGELOG/UPGRADING, `package.json`, fakes, mocks and tests.
  `src/__tests__/packs/` is exempt by design (the test packs stand in for a
  domain pack); the test files listed in
  `scripts/no-domain-terms.test-paths.json` are exempt temporarily, one by
  one, and a listed file that becomes clean fails the run until it is
  removed from the list.
- **tarball** (`pnpm domain-terms:pack`, `--pack <dir>`, `--tarball <tgz>`):
  exactly what `npm pack` publishes, no exemptions.

Brand and vendor names match as case-insensitive substrings; domain words
match per identifier part. `scripts/no-domain-terms.allow.json` lists the
few generic uses (a ring buffer, a focus ring, migration steps, the AI
sampling temperature, …), each with a reason.

## License

MIT
