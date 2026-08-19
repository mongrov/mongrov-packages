# @mongrov/vitals-hooks

The view-model layer the ZivaOne vital screens consume, over
`@mongrov/data-access`.

**Status: types + mock provider.** The real hooks are not here yet.

## The boundary

We own queries, hooks, and every *decided* value — verdict words, zone
vocabulary, thresholds, unit conversion, and all user-facing copy. Screens
render. If a screen needs a word, a number, or a sentence, it comes out of a
hook field; it is never computed in the UI layer.

That is why almost every field is a pre-composed string. `heroValue` is `"96"`
and `heroUnit` is `"%"`, separately and already formatted. If you find yourself
writing `value + '%'`, or an if/else that picks a word, stop — that is our side
of the line.

## Usage

```tsx
import { MockVitalsProvider, useSpO2Day } from '@mongrov/vitals-hooks/mock'

function Screen() {
  const day = useSpO2Day(0) // 0 = today, 1 = yesterday …
  if (day.status !== 'ready')
    return <VitalStateScreen state={day.status} vital={day.meta} />
  return <>{/* render day.* verbatim */}</>
}
```

Wrap in the mock provider to drive every state:

```tsx
<MockVitalsProvider status="learning">
  <Screen />
</MockVitalsProvider>
```

`learning` is worth building against deliberately: there IS data and the chart
renders, but `verdict` is `null`, `worthALook` is `null`, and the compare band
is population rails rather than the user's own. It is unreachable in practice —
it needs a user between day 1 and day 30 — and it is the state screens get
wrong.

## Entry points

| | |
|---|---|
| `@mongrov/vitals-hooks` | types (and the A2 status resolver) |
| `@mongrov/vitals-hooks/mock` | `MockVitalsProvider` + hook signatures |

The mock is a separate entry point rather than a flag: importing it is saying
so out loud, and there is no silent fallback to mock data from the root.

## Contract

`ZivaOne Vitals — UX Interface Contract v1.4`, canonical in the ZivaOne
project. The types in `src/types.ts` ARE that contract — renaming a field here
is a breaking change to every screen.
