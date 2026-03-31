# @mongrov/core

Structured logging framework for React Native / Expo. Zero UI, zero Sentry, zero vendor opinions.

## Install

```bash
npm install @mongrov/core
```

### Peer Dependencies

```bash
npx expo install expo-file-system expo-network react-native-mmkv
```

| Dependency | Why |
|---|---|
| `expo-file-system` | File transport writes rolling daily logs |
| `expo-network` | Offline queue checks connectivity before flushing |
| `react-native-mmkv` | Offline queue persistence (fast, synchronous) |

## Quick Start

```typescript
import { createLogger } from '@mongrov/core'

const logger = createLogger({
  appVersion: '1.0.0',
  ringBuffer: true,
  file: true,
})

logger.info('App started')
logger.error('Something went wrong', { code: 500 })

// Retrieve logs
const logs = logger.getLogs({ level: 'error' })
```

## React Integration

```typescript
import { LoggingProvider, useLogger } from '@mongrov/core'

// In your root layout
export default function RootLayout() {
  return (
    <LoggingProvider config={{ appVersion: '1.0.0', ringBuffer: true, file: true }}>
      <Stack />
    </LoggingProvider>
  )
}

// In any component
function MyScreen() {
  const logger = useLogger()
  logger.info('Screen rendered')
  return <View />
}
```

## Configuration

```typescript
interface LoggerConfig {
  // Minimum level to capture (default: 'debug' in dev, 'info' in prod)
  minLevel?: 'debug' | 'info' | 'warn' | 'error'

  // Built-in transports
  ringBuffer?: RingBufferConfig | boolean  // In-memory circular buffer
  file?: FileConfig | boolean              // Rolling daily file storage
  webhook?: WebhookConfig                  // HTTP POST with batching

  // Custom transports
  transports?: LogTransport[]

  // Static context
  appVersion: string
  updateId?: string

  // Callback hooks
  onError?: (entry: LogEntry) => void
  onException?: (error: Error, context?: Record<string, unknown>) => void
}
```

### Ring Buffer

In-memory circular buffer. Default size: 1000 entries. No persistence.

```typescript
{ ringBuffer: true }                    // defaults
{ ringBuffer: { maxSize: 5000 } }       // custom size
```

### File Transport

Rolling daily log files. JSONL format.

```typescript
{ file: true }                          // defaults
{ file: { maxSizeMB: 10, retentionDays: 14 } }
```

### Webhook Transport

Generic HTTP POST with batching and offline queue.

```typescript
{
  webhook: {
    url: 'https://your-api.com/logs',
    headers: { Authorization: 'Bearer token' },
    batchSize: 10,
    batchIntervalMs: 5000,
    formatPayload: (entries) => ({ text: entries.map(e => e.message).join('\n') }),
  }
}
```

## Custom Transports

Implement the `LogTransport` interface:

```typescript
import type { LogTransport, LogEntry } from '@mongrov/core'

const myTransport: LogTransport = {
  name: 'my-transport',
  async send(entries: LogEntry[]) {
    // your logic here
  },
}

const logger = createLogger({
  appVersion: '1.0.0',
  transports: [myTransport],
})
```

## API Reference

### Logger Methods

| Method | Description |
|---|---|
| `debug(message, data?)` | Log debug message |
| `info(message, data?)` | Log info message |
| `warn(message, data?)` | Log warning message |
| `error(message, data?)` | Log error message |
| `captureException(error, context?)` | Log error + call `onException` callback |
| `setUser(userId)` | Set user ID in context |
| `setScreen(screenName)` | Set current screen in context |
| `setContext(key, value)` | Set custom context key |
| `getLogs(filter?)` | Get logs from ring buffer |
| `exportLogs(filter?)` | Export logs as JSON string |
| `flush()` | Force-push queued webhook entries |
| `destroy()` | Flush pending + cleanup listeners |

### LogFilter

```typescript
{
  level?: 'debug' | 'info' | 'warn' | 'error'  // minimum level
  since?: Date                                    // entries after this time
  search?: string                                 // substring match on message
  limit?: number                                  // max entries to return
}
```

## Usage with Sentry

```typescript
import * as Sentry from '@sentry/react-native'

const logger = createLogger({
  appVersion: '1.0.0',
  ringBuffer: true,
  onError: (entry) => {
    Sentry.addBreadcrumb({
      message: entry.message,
      level: entry.level,
      data: entry.data,
    })
  },
  onException: (error, context) => {
    Sentry.captureException(error, { extra: context })
  },
})
```

## Usage with RocketChat

```typescript
const logger = createLogger({
  appVersion: '1.0.0',
  webhook: {
    url: 'https://your-rocketchat.com/hooks/xxx',
    formatPayload: (entries) => ({
      text: entries
        .map((e) => `[${e.level.toUpperCase()}] ${e.message}`)
        .join('\n'),
    }),
  },
})
```

## License

MIT
