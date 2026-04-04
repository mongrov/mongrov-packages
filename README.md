# @mongrov packages

Shared npm packages for Mongrov React Native / Expo apps.

## Packages

| Package | Version | Description |
|---------|---------|-------------|
| [`@mongrov/types`](./packages/types) | 0.2.0 | Shared TypeScript type definitions |
| [`@mongrov/core`](./packages/core) | 0.4.0 | Structured logging framework |
| [`@mongrov/theme`](./packages/theme) | 0.3.0 | Theme contract and color scheme management |
| [`@mongrov/auth`](./packages/auth) | 0.5.0 | Auth lifecycle, token management, biometric |
| [`@mongrov/db`](./packages/db) | 0.2.0 | Database utilities (KVStore + RxDB) |
| [`@mongrov/collab`](./packages/collab) | 0.2.0 | Collaboration adapter for messaging |
| [`@mongrov/ui`](./packages/ui) | 0.4.0 | Shared UI primitives for React Native |
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

## License

MIT
