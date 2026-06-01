import assert from 'node:assert/strict'
import test from 'node:test'
import { analyzeCarve } from './analyze.js'
import { semanticTokens } from './semantic.js'

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

test('returns semantic tokens for headings and inline markup', () => {
  const result = semanticTokens('# Title\n\nHi *bold* @mark {#id}\n')

  assert.deepEqual(
    result.map((token) => [token.line, token.character, token.length, token.type]),
    [
      [0, 0, 1, 'operator'],
      [0, 2, 5, 'type'],
      [2, 3, 6, 'keyword'],
      [2, 10, 5, 'variable'],
      [2, 16, 5, 'property'],
    ],
  )
})

test('returns semantic tokens for fenced blocks', () => {
  const result = semanticTokens('``` js\nconst x = 1\n```\n')

  assert.deepEqual(
    result.map((token) => [token.line, token.character, token.length, token.type]),
    [
      [0, 0, 3, 'operator'],
      [0, 4, 2, 'type'],
      [1, 0, 11, 'string'],
      [2, 0, 3, 'string'],
    ],
  )
})
