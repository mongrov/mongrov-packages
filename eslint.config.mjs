import antfu from '@antfu/eslint-config'

/**
 * One flat config for the whole workspace.
 *
 * These eleven packages are developed, versioned and released together, so a
 * per-package config would be eleven copies of the same thing drifting apart.
 * ESLint resolves this file from the root for every `packages/*` path.
 *
 * Style follows what the code already is rather than what a preset prefers.
 * A survey before writing this found ~3576 statement lines without semicolons
 * against ~522 with (analytics alone is 2374 of the former), so antfu's
 * default no-semi style is the majority by a wide margin. Choosing the other
 * way would have rewritten analytics wholesale to satisfy a preference.
 */
export default antfu(
  {
    typescript: true,
    react: true,

    // These are libraries, not apps — no JSON/YAML/markdown config to lint,
    // and enabling markdown here is what crashed the app's lint for its whole
    // history (a rule that calls sourceCode.getAllComments() applied to a
    // virtual markdown processor that has no such method).
    jsonc: false,
    yaml: false,
    markdown: false,

    ignores: [
      '**/dist/**',
      '**/node_modules/**',
      '**/coverage/**',
      '**/*.d.ts',
    ],
  },

  {
    files: ['**/*.{ts,tsx}'],
    rules: {
      'ts/consistent-type-imports': ['error', {
        prefer: 'type-imports',
        fixStyle: 'inline-type-imports',
        // `const React = require('react') as typeof import('react')` is a
        // deliberate lazy require whose type comes from an import type. There
        // is no static import to convert it to.
        disallowTypeAnnotations: false,
      }],

      // `new Array(n).fill(null)` in the ring buffer is preallocation, which
      // is the one case where it beats the suggested `Array.from`.
      'unicorn/no-new-array': 'off',

      // This codebase writes compact single-line bodies
      // (`return () => { cancelled = true }`). Two statements is the house
      // style; three is where it stops being readable.
      'style/max-statements-per-line': ['error', { max: 2 }],

      // antfu wants JSX ternaries broken across lines in its own shape. The
      // existing `{cond ? (<A />) : (<B />)}` layout is standard React and
      // reads fine; churning every conditional render to satisfy a preference
      // is not worth the diff.
      'style/multiline-ternary': 'off',

      // React 19 codemods, off on purpose. Every package in this workspace
      // devDepends on react 18.3.1 and compiles against its types, while
      // declaring peer `react >=19` and shipping into an app on 19.1.0.
      // These fixers rewrite to the React 19 API (`use()`, bare `<Context>`),
      // which the locally installed types reject — the build broke on all
      // three of collab, core and auth. Re-enable once the workspace
      // devDeps match the peer range.
      'react/no-use-context': 'off',
      'react/no-context-provider': 'off',

      // `jsdoc/empty-tags` wants `@internal` to carry no description, and its
      // fixer deletes the text. On a single-line block it also eats the
      // delimiters:
      //
      //   /** @internal Expose client for session/interceptor use */
      //    * @internal
      //
      // which is a syntax error and loses the sentence that explained why the
      // export exists. It ships as a warning, and `--fix` fixes warnings too,
      // so it corrupted four files on the first sweep. A described `@internal`
      // is good documentation; the rule is not worth a fixer that does this.
      'jsdoc/empty-tags': 'off',

      // `e18e/prefer-array-at` rewrites `xs[xs.length - 1]` to `xs.at(-1)`.
      // `Array.prototype.at` is ES2022 and this workspace targets ES2020
      // (tsconfig.base.json), so the fixer emits code the compiler rejects —
      // it broke the core build. Raising the workspace to ES2022 is a real
      // decision with runtime implications for older Hermes; it is not
      // something a lint autofix should make on our behalf.
      // The `e18e` plugin assumes a modern JS baseline and proposes ES2022
      // APIs. This workspace targets ES2020 (tsconfig.base.json), so its
      // fixers emit code the compiler rejects — `.at(-1)` broke the core and
      // ai builds, `Object.hasOwn` broke types. Both are genuinely nicer than
      // what they replace; the blocker is the language target, and raising
      // that is a deliberate decision about the oldest Hermes we support, not
      // a side effect of turning lint on.
      'e18e/prefer-array-at': 'off',
      'e18e/prefer-object-has-own': 'off',

      // `e18e/prefer-array-fill` is unsound. It rewrites
      // `Array.from({length: n}, () => f())` to `Array.from({length: n}).fill(f())`,
      // calling `f` ONCE and repeating the result, on the theory that a
      // zero-argument callback is "constant". It is not: the callback is the
      // only thing making the elements distinct.
      //
      // It hit five sites here. One test caught it (50 batch ids collapsed to
      // 1). The two that no test caught are worse: a fixture whose rows all
      // became the same object reference, and a Promise.all over 50
      // concurrent tool calls that became 50 copies of a single promise —
      // a concurrency test that still passes while testing nothing.
      'e18e/prefer-array-fill': 'off',

      // Deliberately NOT enforcing `type` over `interface` here, though the
      // app does. These packages publish their types: an `interface` is open
      // to declaration merging and consumer augmentation, a `type` is not.
      // Rewriting the 454 interfaces in this workspace would be a silent
      // change to the published .d.ts contract to satisfy a preference.
      'ts/consistent-type-definitions': 'off',

      // Carried over from the app's config, same reasoning, same code:
      // React Native leans on `require` for mocks and lazy native modules,
      // `process`/`Buffer` are globals in RN rather than imports, and
      // react-refresh's single-export rule is too strict for files that
      // deliberately co-locate a provider with its hooks.
      'react-refresh/only-export-components': 'warn',
      'node/prefer-global/process': 'off',
      'node/prefer-global/buffer': 'off',
      'ts/no-require-imports': 'off',
      'ts/no-use-before-define': 'off',
      'regexp/no-unused-capturing-group': 'off',

      // Warnings, not errors, and deliberately not "fixed" in this pass.
      //
      // `react-hooks/refs` fires on `useRef(new Animated.Value(1)).current`
      // and on lazy-init singletons read inside a useMemo — the first is
      // straight out of the React Native docs, the second is how the
      // data-access runtime avoids rebuilding its bus and query client.
      //
      // `set-state-in-effect` fires where an async native probe or a
      // collection subscription feeds React state. React 19 prefers
      // derivation, but there is nothing to derive from until the promise
      // resolves.
      //
      // 24 sites across seven published packages. They are worth revisiting,
      // and converting them under a lint sweep — where the only check is that
      // tests still pass — is how you ship a subtle render-timing change to
      // every consumer at once.
      'react-hooks/refs': 'warn',
      'react-hooks/set-state-in-effect': 'warn',
      'react-hooks/globals': 'warn',
    },
  },

  {
    // Build and maintenance scripts run under Node, where `process` is a
    // global rather than something you import.
    files: ['**/scripts/**/*.{js,mjs,cjs}', '*.{js,mjs,cjs}'],
    rules: {
      'node/prefer-global/process': 'off',
      'no-console': 'off',
    },
  },

  {
    // `__typetests__` files exist to be compiled, not run. Their bindings are
    // deliberately unused — declaring one and letting `tsc` accept or reject
    // it IS the assertion. Flagging them as unused inverts the point of the
    // file.
    files: ['**/__typetests__/**'],
    rules: {
      'unused-imports/no-unused-vars': 'off',
      'ts/no-unused-vars': 'off',
    },
  },

  {
    // The logger IS the console wrapper — that is the file's whole job.
    files: ['**/src/logger.ts'],
    rules: { 'no-console': 'off' },
  },

  {
    // DuckDB's `AppenderInstance.flushSync()`. `react-dom/no-flush-sync`
    // matches on the method name alone, so it fires on a database appender
    // in a Node integration harness with no React anywhere in the file.
    files: ['**/__integration__/**'],
    rules: { 'react-dom/no-flush-sync': 'off' },
  },

  {
    // Jest/vitest module mocks for CJS packages need TypeScript's
    // `export =` assignment; there is no ESM spelling of it.
    files: ['**/__mocks__/**'],
    rules: { 'no-restricted-syntax': 'off' },
  },

  {
    // Tests reach for `any` and non-null assertions to build fixtures and to
    // drive error paths on purpose. Holding fixtures to production strictness
    // buys nothing and pushes people toward not writing the test.
    files: ['**/__tests__/**', '**/__integration__/**', '**/__fakes__/**', '**/*.{test,spec}.{ts,tsx}'],
    rules: {
      'ts/no-non-null-assertion': 'off',
      'ts/no-explicit-any': 'off',
      'no-console': 'off',

      // A test title is documentation. Lowercasing 214 of them across this
      // workspace would churn the one string a failing test actually shows
      // you, and buys nothing.
      'test/prefer-lowercase-title': 'off',

      // React Native's `__DEV__` is a global; tests set it directly to drive
      // dev-only branches. And `declare global { var x }` must use `var` —
      // `let`/`const` are not valid in an ambient global declaration.
      'no-restricted-globals': 'off',
      'vars-on-top': 'off',

      // Polling helpers pack a guard and its cleanup onto one line:
      // `if (ready) { clearInterval(t); resolve() }`.
      'style/max-statements-per-line': ['error', { max: 3 }],

      // Fakes and fixtures use compact one-line bodies
      // (`__setResult(rows) { queued = rows; queuedErr = null }`). 19 of the
      // 20 hits are in test doubles, where the compactness is the point.
    },
  },
)
