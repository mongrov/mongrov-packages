# @mongrov/ui

Shared UI primitives and components for React Native applications. Built with NativeWind/Tailwind CSS support.

## Installation

```bash
npm install @mongrov/ui
# or
pnpm add @mongrov/ui
```

### Peer Dependencies

```bash
npm install react react-native uniwind
```

## Features

- **Primitives**: Base components (Button, Text, Card, Skeleton, Separator)
- **State Components**: EmptyState, ErrorState, LoadingState
- **Status Components**: StatusBadge, SyncIndicator, ConnectionIndicator, NetworkBanner
- **Auth Components**: SocialLoginButton, SSOButton, AuthDivider, TenantPicker
- **Renderers**: Headless components for messages, attachments, and reactions

## Usage

### Primitives

```tsx
import { Button, Text, Card, CardHeader, CardTitle, CardContent } from '@mongrov/ui';

function MyComponent() {
  return (
    <Card>
      <CardHeader>
        <CardTitle>Welcome</CardTitle>
      </CardHeader>
      <CardContent>
        <Text variant="body">Hello, world!</Text>
        <Button label="Get Started" onPress={() => {}} />
      </CardContent>
    </Card>
  );
}
```

### Text Variants

```tsx
import { Text } from '@mongrov/ui';

<Text variant="h1">Heading 1</Text>
<Text variant="h2">Heading 2</Text>
<Text variant="body">Body text</Text>
<Text variant="muted">Muted text</Text>
<Text variant="code">Code text</Text>
```

### Button Variants

```tsx
import { Button } from '@mongrov/ui';

<Button variant="default" label="Default" onPress={() => {}} />
<Button variant="destructive" label="Delete" onPress={() => {}} />
<Button variant="outline" label="Outline" onPress={() => {}} />
<Button variant="ghost" label="Ghost" onPress={() => {}} />
<Button loading label="Loading..." onPress={() => {}} />
```

### State Components

```tsx
import { EmptyState, ErrorState, LoadingState } from '@mongrov/ui';

// Empty state
<EmptyState
  title="No items"
  subtitle="Add your first item to get started"
  action={{ label: 'Add Item', onPress: () => {} }}
/>

// Error state
<ErrorState
  title="Something went wrong"
  message="Failed to load data"
  onRetry={() => refetch()}
/>

// Loading state
<LoadingState message="Loading..." size="large" />
```

### Status Components

```tsx
import { StatusBadge, SyncIndicator, ConnectionIndicator, NetworkBanner } from '@mongrov/ui';

// Status badge
<StatusBadge label="Active" variant="success" />
<StatusBadge label="Pending" variant="warning" />
<StatusBadge label="Error" variant="error" />

// Sync indicator
<SyncIndicator status="syncing" />
<SyncIndicator status="idle" label="All synced" />
<SyncIndicator status="error" />

// Connection indicator
<ConnectionIndicator status="connected" />
<ConnectionIndicator status="connecting" />
<ConnectionIndicator status="disconnected" />

// Network banner
<NetworkBanner isConnected={false} message="No internet connection" />
```

### Auth Components

```tsx
import { SocialLoginButton, SSOButton, AuthDivider } from '@mongrov/ui';

// Social login buttons
<SocialLoginButton provider="apple" onPress={() => signInWithApple()} />
<SocialLoginButton provider="google" onPress={() => signInWithGoogle()} />
<SocialLoginButton provider="github" onPress={() => signInWithGithub()} />

// SSO button
<SSOButton
  onPress={() => signInWithSSO()}
  providerName="Okta"
  loading={isLoading}
/>

// Auth divider
<AuthDivider text="or continue with" />
```

### Tenant Picker

For multi-tenant applications, use `TenantPicker` and `TenantSelector`:

```tsx
import { TenantPicker, TenantSelector } from '@mongrov/ui';

const tenants = [
  { id: 'tenant-1', name: 'Acme Corp', description: 'Main organization' },
  { id: 'tenant-2', name: 'Beta Inc', description: 'Secondary org' },
];

function TenantSettings() {
  const [showPicker, setShowPicker] = useState(false);
  const [selectedTenant, setSelectedTenant] = useState(tenants[0]);

  return (
    <>
      {/* Inline selector button */}
      <TenantSelector
        tenant={selectedTenant}
        onPress={() => setShowPicker(true)}
        placeholder="Select organization"
      />

      {/* Modal picker */}
      <TenantPicker
        visible={showPicker}
        tenants={tenants}
        selectedId={selectedTenant?.id}
        onSelect={(id) => {
          setSelectedTenant(tenants.find(t => t.id === id) || null);
          setShowPicker(false);
        }}
        onClose={() => setShowPicker(false)}
        title="Select Organization"
      />
    </>
  );
}
```

### Message Renderer

Headless component for rendering chat messages:

```tsx
import { MessageRenderer, useMessageRenderer } from '@mongrov/ui';

function ChatMessage({ message }) {
  return (
    <MessageRenderer
      message={message}
      currentUserId="user-1"
      renderContent={({ content }) => <Text>{content}</Text>}
      renderDeliveryStatus={({ status }) => <StatusIcon status={status} />}
      renderReactions={({ reactions }) => <ReactionBar reactions={reactions} />}
    />
  );
}
```

### Attachment Renderer

```tsx
import { AttachmentRenderer } from '@mongrov/ui';

<AttachmentRenderer
  attachment={attachment}
  renderImage={({ url, name }) => <Image source={{ uri: url }} />}
  renderVideo={({ url }) => <VideoPlayer url={url} />}
  renderAudio={({ url }) => <AudioPlayer url={url} />}
  renderDocument={({ url, name }) => <DocumentLink url={url} name={name} />}
/>
```

### Reaction Picker

```tsx
import { ReactionPicker, EMOJI_CATEGORIES } from '@mongrov/ui';

<ReactionPicker
  quickReactions={['👍', '❤️', '😂', '😮', '😢', '😡']}
  currentReactions={message.reactions}
  onSelect={(emoji) => addReaction(emoji)}
  onRemove={(emoji) => removeReaction(emoji)}
/>
```

## API Reference

### Primitives

| Component | Props | Description |
|-----------|-------|-------------|
| `Button` | `label`, `variant`, `size`, `loading`, `disabled`, `onPress` | Pressable button |
| `Text` | `variant`, `className` | Typography component |
| `Card` | `className` | Card container |
| `CardHeader` | `className` | Card header section |
| `CardTitle` | `className` | Card title text |
| `CardDescription` | `className` | Card description text |
| `CardContent` | `className` | Card content section |
| `CardFooter` | `className` | Card footer section |
| `Skeleton` | `className` | Loading placeholder |
| `Separator` | `orientation`, `className` | Visual separator |

### State Components

| Component | Props | Description |
|-----------|-------|-------------|
| `EmptyState` | `title`, `subtitle`, `icon`, `action` | Empty list state |
| `ErrorState` | `title`, `message`, `onRetry` | Error display |
| `LoadingState` | `message`, `size` | Loading indicator |

### Status Components

| Component | Props | Description |
|-----------|-------|-------------|
| `StatusBadge` | `label`, `variant` | Status indicator badge |
| `SyncIndicator` | `status`, `label` | Sync status display |
| `ConnectionIndicator` | `status` | Connection status |
| `NetworkBanner` | `isConnected`, `message` | Network status banner |

### Auth Components

| Component | Props | Description |
|-----------|-------|-------------|
| `SocialLoginButton` | `provider`, `onPress`, `loading`, `disabled` | Social login button |
| `SSOButton` | `onPress`, `providerName`, `label`, `loading`, `disabled` | Enterprise SSO button |
| `AuthDivider` | `text` | Divider with text |
| `TenantPicker` | `visible`, `tenants`, `selectedId`, `onSelect`, `onClose`, `title` | Modal tenant picker |
| `TenantSelector` | `tenant`, `onPress`, `placeholder` | Inline tenant selector |

## License

MIT
