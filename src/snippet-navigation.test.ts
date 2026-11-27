import assert from 'node:assert/strict'
import test from 'node:test'
import { pathToFileURL } from 'node:url'
import { analyzeCarve } from './analyze.js'
import { definitionAt } from './definition.js'
import type { IncludeResolved, IncludeResolver } from './include-path.js'
import { WorkspaceIndex, scanDocument } from './workspace-index.js'

const files: Record<string, string> = {
  '/book/vars.crv': 'Lead.\n\n{$ver}: 0.2.3\n',
  '/book/attr.crv': '{.badge}\n{$brand}: Carve\n',
}

const resolver: IncludeResolver = (includePath): IncludeResolved => {
  const id = `/book/${includePath}`
  const source = files[id]
  return source === undefined
    ? { ok: false, id, denial: 'not-found' }
    : { ok: true, id, watch: id, source, bytes: Buffer.byteLength(source, 'utf8') }
}

const includes = { resolver, sourcePath: '/book/main.crv', includeRoot: '/book' }

/** The position of the `n`-th `$name` written in `source`, on the name. */
function at(source: string, name: string, n = 0): { line: number; character: number } {
  let offset = -1
  for (let seen = 0; seen <= n; seen += 1) offset = source.indexOf(`$${name}`, offset + 1)
  const before = source.slice(0, offset + 1)
  return { line: before.split('\n').length - 1, character: offset + 1 - before.lastIndexOf('\n') - 1 }
}

test('snippet definitions and inline and block uses are indexed by name', () => {
  const tokens = scanDocument('file:///a.crv', '{$ver}: 0.2\n\nVersion {{ $ver }}.\n\n{{ $ver }}\n\n`{{ $ver }}`\n')
  assert.deepEqual(tokens.filter((token) => token.kind === 'snippet').map(({ key, declaration, range }) => [key, declaration, range.start.line, range.start.character, range.end.character]), [
    ['ver', true, 0, 2, 5],
    ['ver', false, 2, 12, 15],
    ['ver', false, 4, 4, 7],
  ])
})

test('a definition behind an attribute line keeps its name on the marker line', () => {
  const tokens = scanDocument('file:///a.crv', '{.x}\n{$a .y}{.z}: v\n\n{{ $a }}\n')
  assert.deepEqual(tokens.filter((token) => token.declaration).map(({ key, range }) => [key, range.start.line, range.start.character]), [['a', 1, 2]])
})

test('go to definition from an inline use and a block use lands on the definition name', () => {
  const source = 'Say {{ $ver }}.\n\n{{ $ver }}\n\n{$ver}: 0.2\n'
  for (const n of [0, 1]) {
    assert.deepEqual(definitionAt('file:///a.crv', source, at(source, 'ver', n)), {
      uri: 'file:///a.crv',
      range: { start: { line: 4, character: 2 }, end: { line: 4, character: 5 } },
    })
  }
})

test('go to definition takes the first definition of a name', () => {
  const source = '{$v}: one\n\n{$v}: two\n\n{{ $v }}\n'
  assert.equal(definitionAt('file:///a.crv', source, at(source, 'v', 2))?.range.start.line, 0)
})

test('go to definition reaches a definition an include contributes', () => {
  const source = '{{ vars.crv }}\n\nVersion {{ $ver }}.\n'
  assert.deepEqual(definitionAt('file:///book/main.crv', source, at(source, 'ver'), includes), {
    uri: pathToFileURL('/book/vars.crv').toString(),
    range: { start: { line: 2, character: 2 }, end: { line: 2, character: 5 } },
  })
  const attributed = '{{ attr.crv }}\n\n{{ $brand }}\n'
  assert.equal(definitionAt('file:///book/main.crv', attributed, at(attributed, 'brand'), includes)?.range.start.line, 1)
})

test('a local definition before the include wins over the included one', () => {
  const source = '{$ver}: local\n\n{{ vars.crv }}\n\n{{ $ver }}\n'
  assert.equal(definitionAt('file:///book/main.crv', source, at(source, 'ver', 1), includes)?.uri, 'file:///book/main.crv')
})

test('references from a definition reach every use in the workspace', () => {
  const index = new WorkspaceIndex()
  index.update('file:///a.crv', '{$ver}: 0.2\n\nNow {{ $ver }}.\n', 1)
  index.update('file:///b.crv', '{{ $ver }}\n\nAnd {{ $ver }} again.\n', 1)
  const token = index.tokenAt('file:///a.crv', { line: 0, character: 3 })
  assert.equal(token?.kind, 'snippet')
  assert.deepEqual(index.references('snippet', 'ver', false).map(({ uri, range }) => [uri, range.start.line]), [
    ['file:///a.crv', 2],
    ['file:///b.crv', 0],
    ['file:///b.crv', 2],
  ])
  assert.equal(index.references('snippet', 'ver', true).length, 4)
  assert.equal(index.definitions('snippet', 'ver', 'file:///b.crv')[0]?.uri, 'file:///a.crv')
})

test('a snippet name and an id of the same spelling stay apart', () => {
  const index = new WorkspaceIndex()
  index.update('file:///a.crv', '{#v}\n# V\n\n{$v}: x\n\n{{ $v }} and </#v>\n', 1)
  assert.equal(index.references('snippet', 'v', true).length, 2)
  assert.equal(index.references('heading', 'v', true).length, 2)
})

test('renaming a definition renames the marker and every use across two files', () => {
  const index = new WorkspaceIndex()
  index.update('file:///a.crv', '{$ver}: 0.2\n\nNow {{ $ver }}.\n', 1)
  index.update('file:///b.crv', '{{ $ver }}\n', 1)
  const edit = index.rename('file:///a.crv', { line: 0, character: 2 }, 'release')
  assert.deepEqual(edit?.changes, {
    'file:///a.crv': [
      { range: { start: { line: 0, character: 2 }, end: { line: 0, character: 5 } }, newText: 'release' },
      { range: { start: { line: 2, character: 8 }, end: { line: 2, character: 11 } }, newText: 'release' },
    ],
    'file:///b.crv': [
      { range: { start: { line: 0, character: 4 }, end: { line: 0, character: 7 } }, newText: 'release' },
    ],
  })
  // From a use, with the `$` typed, the same edit.
  assert.deepEqual(index.rename('file:///b.crv', { line: 0, character: 5 }, '$release'), edit)
})

test('a rename to a name the snippet grammar refuses is declined', () => {
  const index = new WorkspaceIndex()
  index.update('file:///a.crv', '{$ver}: 0.2\n\n{{ $ver }}\n', 1)
  for (const name of ['', 'has space', 'é', '-lead', 'a.b']) assert.equal(index.rename('file:///a.crv', { line: 0, character: 2 }, name), null, name)
})

test('no snippet token sits outside a definition marker or a use', () => {
  const index = new WorkspaceIndex()
  index.update('file:///a.crv', '{$ver}: some *value*\n\n{{ $ver }} text\n', 1)
  assert.equal(index.tokenAt('file:///a.crv', { line: 0, character: 12 }), null)
  assert.equal(index.tokenAt('file:///a.crv', { line: 2, character: 13 }), null)
})

test('the workspace pass adds no snippet finding of its own', () => {
  const index = new WorkspaceIndex()
  index.update('file:///a.crv', '{{ $nope }}\n\n{$d}: 1\n', 1)
  index.update('file:///b.crv', '{$d}: 2\n', 1)
  assert.deepEqual(index.diagnostics('file:///a.crv'), [])
})

test('an undefined use reports the engine finding; a duplicate keeps the lint finding', () => {
  const codes = analyzeCarve('{$a}: x\n\nSay {{ $nope }} {{ $a }}\n\n{{ $nope }}\n\n{$a}: y\n').diagnostics
    .map((diagnostic) => [diagnostic.code, diagnostic.range.start.line, diagnostic.range.start.character])
  assert.deepEqual(codes, [
    ['duplicate-snippet', 6, 1],
    ['snippet-unresolved', 2, 4],
    ['snippet-unresolved', 4, 0],
  ])
})

test('a use the include defines is not reported unresolved', () => {
  const diagnostics = analyzeCarve('{{ vars.crv }}\n\n{{ $ver }}\n', { includes }).diagnostics
  assert.deepEqual(diagnostics.filter((diagnostic) => String(diagnostic.code).startsWith('snippet-')), [])
  const missing = analyzeCarve('{{ $ver }}\n').diagnostics
  assert.equal(missing[0]?.code, 'snippet-unresolved')
})

test('a cycle reports the engine finding', () => {
  const codes = analyzeCarve('{$b}: y {{ $b }}\n\n{{ $b }}\n').diagnostics.map((diagnostic) => diagnostic.code)
  assert.ok(codes.includes('snippet-cycle'), codes.join())
})
