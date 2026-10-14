import test from 'node:test'
import assert from 'node:assert/strict'
import { WorkspaceIndex, scanDocument } from './workspace-index.js'
import { codeLenses } from './codelens.js'
import { documentHighlights } from './document-highlights.js'
import { definitionAt } from './definition.js'
import { referencesAt } from './references.js'
import { renameEdits } from './rename.js'
import { completionAt } from './completion.js'
import { hoverAt } from './hover.js'
import { documentLinks } from './document-links.js'
import { includeDefinitionAt } from './include-definition.js'
import { includeCompletions } from './include-completion.js'
import { fileSystemResolver } from './include-path.js'
import { mkdtempSync, realpathSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'

const keys = (source: string) =>
  scanDocument('file:///a.crv', source).map(({ kind, key, declaration }) => `${kind}:${key}:${declaration ? 'decl' : 'use'}`)

test('footnotes are scoped to the document that writes them', () => {
  const index = new WorkspaceIndex()
  index.update('file:///a.crv', 'A[^1].\n\n[^1]: a note\n', 1)
  index.update('file:///b.crv', 'B[^1].\n\n[^1]: b note\n\nC[^2].\n', 1)
  index.update('file:///c.crv', '[^2]: elsewhere\n', 1)

  const edit = index.rename('file:///a.crv', { line: 0, character: 3 }, 'one')
  assert.deepEqual(Object.keys(edit?.changes ?? {}), ['file:///a.crv'])
  assert.equal(edit?.changes?.['file:///a.crv']?.length, 2)

  assert.deepEqual(index.diagnostics('file:///b.crv').map(({ code }) => code), ['workspace-unresolved-footnote'])
  assert.equal(index.references('footnote', '1', true, 'file:///b.crv').length, 2)
})

test('link reference labels are scoped to their document', () => {
  const index = new WorkspaceIndex()
  index.update('file:///a.crv', 'See [x][site].\n\n[site]: https://a.example\n', 1)
  index.update('file:///b.crv', 'See [y][site].\n\n[site]: https://b.example\n', 1)
  assert.deepEqual(index.diagnostics('file:///b.crv'), [])
  const edit = index.rename('file:///b.crv', { line: 0, character: 10 }, 'home')
  assert.deepEqual(Object.keys(edit?.changes ?? {}), ['file:///b.crv'])
})

test('generated heading ids in two files are not a duplicate', () => {
  const index = new WorkspaceIndex()
  index.update('file:///a.crv', '# Overview\n', 1)
  index.update('file:///b.crv', '# Overview\n', 1)
  assert.deepEqual(index.diagnostics('file:///b.crv'), [])
})

test('renaming a generated id inside a block quote keeps the attribute in the quote', () => {
  const index = new WorkspaceIndex()
  index.update('file:///a.crv', '> # Quoted\n\nSee </#Quoted>.\n', 1)
  const edit = index.rename('file:///a.crv', { line: 2, character: 8 }, 'quoted')
  assert.deepEqual(edit?.changes?.['file:///a.crv'], [
    { range: { start: { line: 0, character: 2 }, end: { line: 0, character: 2 } }, newText: '{#quoted}\n> ' },
    { range: { start: { line: 2, character: 7 }, end: { line: 2, character: 13 } }, newText: 'quoted' },
  ])
})

test('renaming a generated id inside a list item indents the heading under the item', () => {
  const index = new WorkspaceIndex()
  index.update('file:///a.crv', '- # In list\n\nSee </#In-list>.\n', 1)
  const edit = index.rename('file:///a.crv', { line: 2, character: 8 }, 'item')
  assert.deepEqual(edit?.changes?.['file:///a.crv']?.[0], {
    range: { start: { line: 0, character: 2 }, end: { line: 0, character: 2 } },
    newText: '{#item}\n  ',
  })
})

test('the index ignores code, raw blocks, comments and code spans', () => {
  const source = [
    '```',
    '[^1]: fake',
    '{#fake}',
    '# Not a heading',
    '```',
    '',
    '%% </#gone> [^2]',
    '',
    '%%%',
    '[^3]: hidden',
    '%%%',
    '',
    '```=html',
    '<a href="#x">[^4]</a>',
    '```',
    '',
    'Real [^5] and `[^6]` and `</#code>`.',
    '',
    '[^5]: real',
    '',
  ].join('\n')
  assert.deepEqual(keys(source), ['footnote:5:use', 'footnote:5:decl'])
})

test('a heading id is the one the parser builds', () => {
  assert.deepEqual(keys('# Title {#tid}\n'), ['heading:Title-tid:decl'])
})

test('headings in list items, definitions and footnotes are declarations', () => {
  const source = [
    '- # In list',
    '',
    ':: Term',
    ': # In def',
    '',
    'Note[^n] and </#In-list> </#In-def> </#In-note>.',
    '',
    '[^n]: # In note',
    '',
  ].join('\n')
  const index = new WorkspaceIndex()
  index.update('file:///a.crv', source, 1)
  assert.deepEqual(index.diagnostics('file:///a.crv'), [])
})

test('rename refuses ids the parser cannot read back', () => {
  const index = new WorkspaceIndex()
  index.update('file:///a.crv', '{#intro}\n# Intro\n\nSee </#intro>.\n', 1)
  for (const name of ['new>x', 'a}b', 'a b', '-lead', 'Über']) {
    assert.equal(index.rename('file:///a.crv', { line: 3, character: 8 }, name), null, name)
  }
  assert.ok(index.rename('file:///a.crv', { line: 3, character: 8 }, '1st-part_2'))
})

test('code lenses count only real footnote references', () => {
  const source = 'A[^1] and `[^1]`.\n\n```\n[^1]\n[^2]: fake\n```\n\n[^1]: note\n'
  const lenses = codeLenses(source)
  assert.deepEqual(lenses.map((lens) => [lens.range.start.line, lens.command?.title]), [[7, '1 reference']])
})

test('document highlights skip occurrences inside a fence', () => {
  const source = 'A[^1].\n\n```\n[^1]\n```\n\n[^1]: note\n'
  assert.deepEqual(documentHighlights('file:///a.crv', source, { line: 0, character: 3 }).map((h) => h.range.start.line), [0, 6])
})

const URI = 'file:///doc.crv'

test('footnote navigation ignores a definition inside a fence', () => {
  const source = 'See[^n].\n\n```\n[^n]: fake\n```\n\n[^n]: real\n'
  assert.equal(definitionAt(URI, source, { line: 0, character: 5 })?.range.start.line, 6)
  assert.deepEqual(
    referencesAt(URI, source, { line: 0, character: 5 }, { includeDeclaration: true })?.map((l) => l.range.start.line),
    [0, 6],
  )
  assert.deepEqual(
    Object.values(renameEdits(URI, source, { line: 0, character: 5 }, 'm')?.changes ?? {})[0]?.map((e) => e.range.start.line),
    [0, 6],
  )
  assert.equal(definitionAt(URI, source, { line: 3, character: 2 }), null)
})

test('cross-references with non-ASCII ids navigate', () => {
  const source = '# Über uns\n\nSee </#Über-uns> and [here](#Über-uns).\n'
  assert.equal(definitionAt(URI, source, { line: 2, character: 8 })?.range.start.line, 0)
  assert.equal(definitionAt(URI, source, { line: 2, character: 30 })?.range.start.line, 0)
  assert.equal(referencesAt(URI, source, { line: 0, character: 3 }, { includeDeclaration: false })?.length, 2)
})

test('a collapsed reference jumps to the heading it links to', () => {
  const source = '# Intro Part\n\nSee [Intro Part][] and [[Intro Part]].\n'
  assert.equal(definitionAt(URI, source, { line: 2, character: 7 })?.range.start.line, 0)
})

test('a collapsed reference with a definition jumps to the definition', () => {
  const source = '# Intro Part\n\nSee [Intro Part][].\n\n[Intro Part]: https://example.com\n'
  assert.equal(definitionAt(URI, source, { line: 2, character: 7 })?.range.start.line, 4)
})

test('headings inside list items, definitions and footnotes are found', () => {
  const source = '- # In list\n\n:: Term\n: # In def\n\nSee </#In-list> </#In-def> </#In-note>[^n].\n\n[^n]: # In note\n'
  assert.equal(definitionAt(URI, source, { line: 5, character: 8 })?.range.start.line, 0)
  assert.equal(definitionAt(URI, source, { line: 5, character: 20 })?.range.start.line, 3)
  assert.equal(definitionAt(URI, source, { line: 5, character: 30 })?.range.start.line, 7)
  assert.equal(referencesAt(URI, source, { line: 0, character: 4 }, { includeDeclaration: false })?.length, 1)
})

const labels = (source: string, line: number, character: number) =>
  completionAt(source, { line, character }).map((item) => item.label)

test('crossref completion takes non-ASCII ids and headings in containers', () => {
  const source = '# Über uns\n\n- # In list\n\nSee </#Üb'
  assert.ok(labels(source, 4, 9).includes('Über-uns'))
  assert.ok(labels('# Über uns\n\n- # In list\n\nSee </#', 4, 7).includes('In-list'))
})

test('semantic span names complete in a span attribute block only', () => {
  assert.ok(labels('[Tab]{k', 0, 7).includes('kbd'))
  assert.ok(!labels('Note:a', 0, 6).includes('kbd'))
  assert.ok(!labels('{k', 0, 2).includes('kbd'))
})

test('hover follows the parser, not a markup regex', () => {
  assert.equal(hoverAt('Use a/b and c/d, 2*3*4.\n', { line: 0, character: 6 }), null)
  assert.equal(hoverAt('Use a/b and c/d, 2*3*4.\n', { line: 0, character: 19 }), null)
  const inNote = 'Text[^n].\n\n# Target\n\n[^n]: See </#Target>.\n'
  assert.match(hoverText(hoverAt(inNote, { line: 4, character: 12 })), /Cross-reference/)
  const inLineBlock = '# Target\n\n::: |\nSee </#Target>.\n:::\n'
  assert.match(hoverText(hoverAt(inLineBlock, { line: 3, character: 7 })), /Cross-reference/)
})

test('a captioned figure in a list item is a crossref target', () => {
  const source = '- {#fig}\n  ![Plot](plot.svg)\n  ^ Figure #: A plot\n\nSee </#fig>.\n'
  assert.equal(definitionAt(URI, source, { line: 4, character: 7 })?.range.start.line, 1)
  assert.match(hoverText(hoverAt(source, { line: 4, character: 7 })), /Figure 1/)
})

test('document links come from the links the parser built', () => {
  const source = [
    '[a](http://x.org/a_(b)) `[c](http://code.example)` <ftp://f.example/x> <http://x.org/a b>',
    '',
    '> [q]: http://q.example/x',
    '',
  ].join('\n')
  const links = documentLinks('file:///docs/a.crv', source)
  assert.deepEqual(links.map((link) => link.target), ['http://x.org/a_(b)', 'ftp://f.example/x', 'http://q.example/x'])
  assert.deepEqual(links[0]!.range, { start: { line: 0, character: 4 }, end: { line: 0, character: 22 } })
})

test('include definition and completion skip directives in code and comments', () => {
  const root = realpathSync(mkdtempSync(path.join(tmpdir(), 'carve-lsp-nav-')))
  test.after(() => rmSync(root, { recursive: true, force: true }))
  writeFileSync(path.join(root, 'child.crv'), '# Child\n')
  const options = { resolver: fileSystemResolver(root, {}), includeRoot: root, sourcePath: path.join(root, 'main.crv') }
  const source = '> ```\n> {{ child.crv }}\n> ```\n\n%%%\n{{ child.crv }}\n%%%\n\n`{{ child.crv }}`\n\n> {{ child.crv }}\n'
  assert.equal(includeDefinitionAt(source, { line: 1, character: 5 }, options), null)
  assert.equal(includeDefinitionAt(source, { line: 5, character: 4 }, options), null)
  assert.equal(includeDefinitionAt(source, { line: 8, character: 4 }, options), null)
  assert.ok(includeDefinitionAt(source, { line: 10, character: 5 }, options))
  assert.deepEqual(includeCompletions('`{{ chi`', { line: 0, character: 7 }, options), [])
  assert.deepEqual(includeCompletions('%% {{ chi', { line: 0, character: 9 }, options), [])
  assert.ok(includeCompletions('{{ chi', { line: 0, character: 6 }, options).length > 0)
})

function hoverText(hover: ReturnType<typeof hoverAt>): string {
  const contents = hover?.contents
  return contents && typeof contents === 'object' && 'value' in contents ? contents.value : ''
}
