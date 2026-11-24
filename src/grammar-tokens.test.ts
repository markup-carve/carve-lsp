import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { dirname, resolve } from 'node:path'
import test from 'node:test'
import { fileURLToPath } from 'node:url'
import { CARVE_GRAMMARS_REV, carveGrammarSource } from './carve-grammar.js'
import { clearGrammarCache, grammarTokens } from './grammar-tokens.js'
import { tokenTypeOf } from './semantic.js'

test('the vendored grammar names the carve-grammars commit it came from', () => {
  assert.match(CARVE_GRAMMARS_REV, /^[0-9a-f]{40}$/)
  assert.equal((JSON.parse(carveGrammarSource) as { scopeName: string }).scopeName, 'source.carve')
})

test('grammar tokens cover a line with UTF-16 offsets that stay inside it', () => {
  const tokens = grammarTokens('# Tïtle 😀 *x*\n')
  assert.ok(tokens.length > 0)
  for (const token of tokens) assert.ok(token.end <= (token.line === 0 ? '# Tïtle 😀 *x*'.length : 0))
  assert.ok(tokens.some((token) => token.scopes.some((scope) => scope.startsWith('markup.heading'))))
})

test('a code body maps to no token, its fence to an operator', () => {
  assert.equal(tokenTypeOf(['source.carve', 'markup.fenced_code.block.carve', 'markup.raw.code.carve', 'meta.embedded.block.js']), null)
  assert.deepEqual(tokenTypeOf(['source.carve', 'markup.fenced_code.block.carve', 'punctuation.definition.fenced.carve']), { type: 'operator' })
})

test('the grammar modules reach no Node.js built-in', () => {
  const here = dirname(fileURLToPath(import.meta.url))
  const external = new Set<string>()
  for (const file of ['grammar-tokens.js', 'carve-grammar.js']) {
    const source = readFileSync(resolve(here, file), 'utf8')
    for (const match of source.matchAll(/(?:import|export)\s[^'"]*?from\s*['"]([^'"]+)['"]/g)) {
      if (!match[1]!.startsWith('.')) external.add(match[1]!)
    }
  }
  assert.deepEqual([...external].sort(), ['@shikijs/core', '@shikijs/engine-javascript'])
})

test('an edit re-tokenized from the recent sources equals a fresh run', () => {
  const base = ['# Title', '', 'Para *x* `y`', '', '- item', '', 'tail %% c', '', '| a | b |', '', 'end']
  const edits = [
    base,
    [...base.slice(0, 3), '```js', ...base.slice(3)],
    base,
    [...base.slice(0, 5), '%%%', ...base.slice(5)],
    [...base.slice(0, 5), '%%%', ...base.slice(5), '%%%'],
    base.slice(0, 6),
    [...base, 'more'],
    ['---', 'a: 1', '---', ...base],
    base.map((line) => line.replace('item', 'changed')),
  ]
  for (const lines of edits) {
    const source = lines.join('\n')
    const incremental = grammarTokens(source)
    clearGrammarCache()
    assert.deepEqual(incremental, grammarTokens(source), source)
  }
  clearGrammarCache()
  for (const lines of edits) grammarTokens(lines.join('\n'))
  for (const lines of [...edits].reverse()) {
    const source = lines.join('\n')
    const incremental = grammarTokens(source)
    clearGrammarCache()
    const fresh = grammarTokens(source)
    for (const other of edits) grammarTokens(other.join('\n'))
    assert.deepEqual(incremental, fresh, source)
  }
})
