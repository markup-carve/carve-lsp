import assert from 'node:assert/strict'
import test from 'node:test'
import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { analyzeCarve } from './analyze.js'
import { completionAt } from './completion.js'
import { hoverAt } from './hover.js'
import { includeCompletions } from './include-completion.js'
import type { IncludeResolved, IncludeResolver } from './include-path.js'
import { semanticTokens } from './semantic.js'

const files: Record<string, string> = {
  '/book/vars.crv': 'Lead.\n\n{$ver}: 0.2.3\n',
}

const resolver: IncludeResolver = (includePath): IncludeResolved => {
  const id = `/book/${includePath}`
  const source = files[id]
  return source === undefined
    ? { ok: false, id, denial: 'not-found' }
    : { ok: true, id, watch: id, source, bytes: Buffer.byteLength(source, 'utf8') }
}

const includes = { resolver, sourcePath: '/book/main.crv', includeRoot: '/book' }

function end(source: string): { line: number; character: number } {
  const lines = source.split('\n')
  return { line: lines.length - 1, character: lines[lines.length - 1]!.length }
}

test('completion after `{{ $` offers every snippet name once, with its value', () => {
  const source = '{$ver}: 0.2\n{$brand}: *Carve*\n{$ver}: later\n\nSay {{ $'
  const items = completionAt(source, end(source))
  assert.deepEqual(items.map((item) => [item.label, item.detail]), [['$ver', '0.2'], ['$brand', '*Carve*']])
  assert.deepEqual(items[0]!.textEdit, { range: { start: end(source), end: end(source) }, newText: 'ver' })
})

test('completion replaces the partial name, inline and on a block line', () => {
  for (const source of ['{$ver}: 0.2\n\nSay {{ $ve', '{$ver}: 0.2\n\n{{ $ve']) {
    const items = completionAt(source, end(source))
    assert.equal(items.length, 1)
    const at = end(source)
    assert.deepEqual(items[0]!.textEdit, { range: { start: { line: at.line, character: at.character - 2 }, end: at }, newText: 'ver' })
  }
})

test('completion offers the names an include contributes', () => {
  const source = '{{ vars.crv }}\n\n{$own}: x\n\nSee {{ $'
  assert.deepEqual(completionAt(source, end(source), { includes }).map((item) => [item.label, item.detail]), [['$ver', '0.2.3'], ['$own', 'x']])
  assert.deepEqual(completionAt(source, end(source)).map((item) => item.label), ['$own'])
})

test('no snippet completion inside code', () => {
  const source = '{$ver}: 0.2\n\n`{{ $`'
  assert.deepEqual(completionAt(source, { line: 2, character: 5 }), [])
})

test('include path completion leaves the `{{ $` slot to snippets', () => {
  const root = mkdtempSync(path.join(tmpdir(), 'lsp681-'))
  mkdirSync(path.join(root, '$dir'))
  writeFileSync(path.join(root, '$file.crv'), 'x\n')
  const options = { resolver, sourcePath: path.join(root, 'main.crv'), includeRoot: root }
  assert.deepEqual(includeCompletions('{{ $', { line: 0, character: 4 }, options), [])
  assert.ok(includeCompletions('{{ ', { line: 0, character: 3 }, options).length > 0)
})

test('hover on a use shows the definition value as Carve source', () => {
  const source = '{$v}: *Hi* `there`\n\nSay {{ $v }}.\n'
  assert.deepEqual(hoverAt(source, { line: 2, character: 9 }), {
    contents: { kind: 'markdown', value: '**Snippet `$v`**\n\n```carve\n*Hi* `there`\n```' },
    range: { start: { line: 2, character: 4 }, end: { line: 2, character: 12 } },
  })
})

test('hover fences a value that holds a backtick run longer than three', () => {
  const value = (hoverAt('{$v}: ````x````\n\n{{ $v }}\n', { line: 2, character: 4 })?.contents as { value: string }).value
  assert.ok(value.includes('`````carve\n````x````\n`````'), value)
})

test('hover on a use no definition names shows the engine finding', () => {
  const source = 'Say {{ $nope }}.\n'
  const message = analyzeCarve(source).diagnostics.find((diagnostic) => diagnostic.code === 'snippet-unresolved')!.message
  assert.deepEqual(hoverAt(source, { line: 0, character: 9 })?.contents, { kind: 'markdown', value: `**Snippet \`$nope\`**\n\n${message}` })
})

test('hover reaches a value an include contributes', () => {
  const source = '{{ vars.crv }}\n\n{{ $ver }}\n'
  assert.deepEqual(hoverAt(source, { line: 2, character: 5 }, includes)?.contents, { kind: 'markdown', value: '**Snippet `$ver`**\n\n```carve\n0.2.3\n```' })
})

test('definitions are document symbols under their section', () => {
  const symbols = analyzeCarve('{$a}: top\n\n# H\n\n{$b}: in *h*\n\n{{ $a }} {{ $b }}\n').symbols
  assert.deepEqual(symbols.map((symbol) => [symbol.name, symbol.detail, symbol.children?.map((child) => [child.name, child.detail, child.selectionRange.start])]), [
    ['$a', 'top', undefined],
    ['H', undefined, [['$b', 'in h', { line: 4, character: 2 }]]],
  ])
})

const tokensOf = (source: string): unknown[] => semanticTokens(source).map((token) => [token.line, token.character, token.length, token.type, ...(token.modifiers ?? [])])

test('a definition marker and a use get snippet tokens, not include tokens', () => {
  assert.deepEqual(tokensOf('{$name}: Hello\n\nSay {{ $name }} x\n\n{{ $name }}\n'), [
    [0, 0, 2, 'operator'], [0, 2, 4, 'variable', 'declaration'], [0, 6, 2, 'operator'],
    [2, 4, 2, 'operator'], [2, 7, 5, 'variable'], [2, 13, 2, 'operator'],
    [4, 0, 2, 'operator'], [4, 3, 5, 'variable'], [4, 9, 2, 'operator'],
  ])
})

test('marker attribute parts color as attributes', () => {
  assert.deepEqual(tokensOf('{$b .y}{.z}: v\n'), [[0, 0, 2, 'operator'], [0, 2, 1, 'variable', 'declaration'], [0, 3, 8, 'property'], [0, 11, 1, 'operator']])
})

test('a run around a use keeps its color on either side, and code keeps its own', () => {
  assert.deepEqual(tokensOf('*Say {{ $v }} x*\n'), [[0, 0, 5, 'keyword'], [0, 5, 2, 'operator'], [0, 8, 2, 'variable'], [0, 11, 2, 'operator'], [0, 13, 3, 'keyword']])
  assert.deepEqual(tokensOf('`{{ $v }}`\n'), [[0, 0, 10, 'string']])
})
