import assert from 'node:assert/strict'
import test from 'node:test'
import { analyzeCarve } from './analyze.js'

test('returns heading document symbols', () => {
  const result = analyzeCarve('# One\n\n## Two\n')
  assert.equal(result.symbols.length, 1)
  assert.equal(result.symbols[0]!.name, 'One')
  assert.equal(result.symbols[0]!.children?.[0]?.name, 'Two')
})

test('reports migration warnings', () => {
  const result = analyzeCarve('_italic_')
  assert.equal(result.diagnostics.length, 1)
  assert.equal(result.diagnostics[0]!.code, 'djot-emphasis-underscore')
})
