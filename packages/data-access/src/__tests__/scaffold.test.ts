import { describe, expect, it } from 'vitest'

import * as pkg from '../index'
import * as eslint from '../eslint/index'

describe('@mongrov/data-access scaffold', () => {
  it('root barrel exports the error taxonomy', () => {
    expect(pkg.DataAccessError).toBeTypeOf('function')
    expect(pkg.AuthorizationError).toBeTypeOf('function')
    expect(pkg.NotImplementedError).toBeTypeOf('function')
  })

  it('./eslint subpath resolves as an object module', () => {
    expect(eslint).toBeTypeOf('object')
  })
})
