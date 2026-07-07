import { describe, expect, it } from 'vitest'

describe('@mongrov/analytics scaffold', () => {
  it('root barrel resolves', async () => {
    const mod = await import('../index')
    expect(mod).toBeDefined()
  })

  it('exposes all declared subpaths at source', async () => {
    // Import each subpath by relative path to confirm the files compile and load.
    const subpaths = ['../core', '../rules', '../tools', '../sync', '../ui']
    for (const p of subpaths) {
      const mod = await import(p)
      expect(mod).toBeDefined()
    }
  })
})
