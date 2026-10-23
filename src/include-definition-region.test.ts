import assert from 'node:assert/strict'
import test from 'node:test'
import { includeDefinitionAt } from './include-definition.js'
import type { IncludeOptions } from './includes.js'

const child = ['intro', '%% #region plain', 'in carve', '%% #endregion', '// #region code-only', 'in code', '// #endregion', ''].join('\n')

const options: IncludeOptions = {
  resolver: (path) => ({ ok: true, id: `/root/${path}`, source: child }) as ReturnType<NonNullable<IncludeOptions['resolver']>>,
  sourcePath: '/root/doc.crv',
}

function landing(directive: string): number | undefined {
  return includeDefinitionAt(`{{ ${directive} }}\n`, { line: 0, character: 4 }, options)?.range.start.line
}

test('go to definition lands on the first line of a Carve region', () => {
  assert.equal(landing('child.crv @region:plain'), 2)
})

test('a source-comment region is found for @code includes only, as the engine reads it', () => {
  assert.equal(landing('child.crv @region:code-only @code'), 5)
  assert.equal(landing('child.crv @region:code-only'), 0)
})
