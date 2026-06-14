import assert from 'node:assert/strict'
import test from 'node:test'
import { analyzeCarve } from './analyze.js'
import { hoverAt } from './hover.js'
import { migrationCodeActions } from './migration-actions.js'
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
  assert.deepEqual(result.diagnostics[0]!.range, {
    start: { line: 0, character: 0 },
    end: { line: 0, character: 8 },
  })
})

test('surfaces lintCarve silent-failure warnings as diagnostics', () => {
  const result = analyzeCarve('# Intro\n\nSee </#nope>.')
  const lint = result.diagnostics.find((d) => d.code === 'broken-crossref')
  assert.ok(lint, 'expected a broken-crossref diagnostic')
  assert.equal(lint.source, 'carve')
  assert.equal(lint.range.start.line, 2)
})

test('returns quick fixes for migration warnings', () => {
  const source = '_italic_ and **bold**'
  const diagnostics = analyzeCarve(source).diagnostics
  const actions = migrationCodeActions('file:///demo.crv', source, diagnostics)

  assert.equal(actions.length, 2)
  assert.equal(actions[0]!.title, 'Convert to Carve syntax: /italic/')
  assert.deepEqual(actions[0]!.edit?.changes?.['file:///demo.crv']?.[0], {
    range: {
      start: { line: 0, character: 0 },
      end: { line: 0, character: 8 },
    },
    newText: '/italic/',
  })
})

test('returns hover help for inline markup', () => {
  const hover = hoverAt('Use /italic/ text', { line: 0, character: 6 })

  assert.ok(hover)
  assert.equal(typeof hover.contents, 'object')
  assert.ok(!Array.isArray(hover.contents))
  assert.notEqual(typeof hover.contents, 'string')
  const contents = hover.contents as { value?: string }
  assert.match(contents.value ?? '', /Italic/)
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
    ],
  )
})

test('returns semantic tokens for fenced blocks', () => {
  const result = semanticTokens('``` js\nconst x = 1\n```\n')

  assert.deepEqual(
    result.map((token) => [token.line, token.character, token.length, token.type]),
    [
      [0, 0, 6, 'string'],
      [1, 0, 11, 'string'],
      [2, 0, 3, 'string'],
    ],
  )
})
