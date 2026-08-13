/**
 * ESLint rule — `no-storage-engine-imports`.
 *
 * Prevents screens (and other non-registry files) from reaching directly
 * into the storage-engine packages (@mongrov/analytics, @mongrov/collab,
 * @mongrov/db). All data must flow through named queries + mutations in
 * the app's data-access registry via useAppQuery / useAppMutation.
 *
 * Files under `allowedDirs` are exempt so the registry itself can wire
 * engine adapters.
 *
 * See data-access/spec.md §ESLint plugin.
 */

import type { Rule } from 'eslint'
import * as path from 'node:path'

interface Options {
  allowedDirs: string[]
  blockedPackages: string[]
}

/** Default block list — the three storage engines the spec forbids. */
const DEFAULT_BLOCKED_PACKAGES = [
  '@mongrov/analytics',
  '@mongrov/collab',
  '@mongrov/db',
]

/** Default allow list — empty; apps supply their registry dirs. */
const DEFAULT_ALLOWED_DIRS: string[] = []

const optionsSchema = {
  type: 'object',
  properties: {
    allowedDirs: {
      type: 'array',
      items: { type: 'string' },
      description:
        'Path segments (relative or absolute) that suppress the rule for files whose path contains any of these fragments. Typical values include the registry directory (e.g. "src/data").',
    },
    blockedPackages: {
      type: 'array',
      items: { type: 'string' },
      description:
        'Package names to block. Subpaths are matched (e.g. blocking "@mongrov/db" also blocks "@mongrov/db/kv").',
    },
  },
  additionalProperties: false,
} as const

const rule: Rule.RuleModule = {
  meta: {
    type: 'problem',
    docs: {
      description:
        'Disallow direct imports of storage-engine packages (@mongrov/analytics, @mongrov/collab, @mongrov/db). Use the data-access registry instead.',
      recommended: true,
      url: 'https://github.com/mongrov/mongrov-packages/tree/main/packages/data-access#eslint-plugin',
    },
    schema: [optionsSchema],
    messages: {
      blockedImport:
        'Direct import of "{{importedPackage}}" is blocked in "{{file}}". Route reads through useAppQuery(name, input) and writes through useAppMutation(name) from your data-access registry, or add this directory to `allowedDirs`.',
    },
  },
  create(context) {
    const options = resolveOptions(
      context.options[0] as Partial<Options> | undefined,
    )
    const filename = context.filename ?? context.getFilename?.() ?? '<input>'

    if (isAllowed(filename, options.allowedDirs)) {
      return {}
    }

    function report(node: Rule.Node, importedPackage: string) {
      context.report({
        node,
        messageId: 'blockedImport',
        data: {
          importedPackage,
          file: relativize(filename),
        },
      })
    }

    function checkSource(node: Rule.Node, source: string | null | undefined) {
      if (!source)
        return
      const match = matchBlocked(source, options.blockedPackages)
      if (match)
        report(node, match)
    }

    return {
      ImportDeclaration(node) {
        // eslint's AST types leak — cast to any for the source literal.
        const src = (node as unknown as { source: { value?: unknown } }).source?.value
        if (typeof src === 'string') {
          checkSource(node as unknown as Rule.Node, src)
        }
      },
      ImportExpression(node) {
        const src = (node as unknown as { source: { value?: unknown } }).source?.value
        if (typeof src === 'string') {
          checkSource(node as unknown as Rule.Node, src)
        }
      },
      CallExpression(node) {
        const callee = (node as unknown as { callee: { name?: string, type: string } })
          .callee
        if (!callee || callee.type !== 'Identifier' || callee.name !== 'require') {
          return
        }
        const args = (node as unknown as { arguments: Array<{ type: string, value?: unknown }> })
          .arguments
        const first = args[0]
        if (first && first.type === 'Literal' && typeof first.value === 'string') {
          checkSource(node as unknown as Rule.Node, first.value)
        }
      },
    }
  },
}

// --- helpers ---------------------------------------------------------

function resolveOptions(raw: Partial<Options> | undefined): Options {
  return {
    allowedDirs: raw?.allowedDirs ?? DEFAULT_ALLOWED_DIRS,
    blockedPackages: raw?.blockedPackages ?? DEFAULT_BLOCKED_PACKAGES,
  }
}

function isAllowed(filename: string, allowedDirs: string[]): boolean {
  if (allowedDirs.length === 0)
    return false
  const normalized = filename.split(path.sep).join('/')
  return allowedDirs.some((dir) => {
    const normalizedDir = dir.split(path.sep).join('/')
    return normalized.includes(normalizedDir)
  })
}

function matchBlocked(
  source: string,
  blockedPackages: string[],
): string | null {
  for (const pkg of blockedPackages) {
    if (source === pkg || source.startsWith(`${pkg}/`)) {
      return pkg
    }
  }
  return null
}

function relativize(filename: string): string {
  if (filename === '<input>')
    return filename
  try {
    const rel = path.relative(process.cwd(), filename)
    // Show relative form when it's a descendant; keep absolute when it isn't.
    return rel.startsWith('..') ? filename : rel
  }
  catch {
    return filename
  }
}

export default rule
export { DEFAULT_ALLOWED_DIRS, DEFAULT_BLOCKED_PACKAGES }
