# @mongrov packages

Shared npm packages for Mongrov React Native / Expo apps.

## Packages

| Package | Version | Description |
|---------|---------|-------------|
| [`@mongrov/core`](./packages/core) | 0.2.0 | Structured logging framework |
| `@mongrov/theme` | planned | Theme contract and color scheme management |
| `@mongrov/auth` | planned | Auth lifecycle, token management, biometric |

## Development

```bash
pnpm install
pnpm run build        # Build all packages
pnpm run test         # Test all packages
pnpm run typecheck    # Typecheck all packages
```

### Single package

```bash
pnpm --filter @mongrov/core run test
pnpm --filter @mongrov/core run build
```

## License

MIT
