import assert from 'node:assert/strict'
import test from 'node:test'
import { analyzeCarve } from './analyze.js'
import { foldingRanges } from './folding.js'
import { inlayHints } from './inlay-hints.js'
import { clearParseCache, resolvedDocument } from './parse-cache.js'
import { semanticTokens } from './semantic.js'

const regions = (source: string) =>
  foldingRanges(source).filter((range) => range.kind === 'region').map(({ startLine, endLine }) => [startLine, endLine])

test('broken-crossref after an astral character is ranged in UTF-16', () => {
  const [diagnostic] = analyzeCarve('😀😀 see </#nope>\n').diagnostics.filter((d) => d.code === 'broken-crossref')
  assert.deepEqual(diagnostic!.range, { start: { line: 0, character: 9 }, end: { line: 0, character: 17 } })
})

test('broken-crossref keeps its column under CRLF line endings', () => {
  const [diagnostic] = analyzeCarve('x\r\n\r\nsee </#nope>\r\n').diagnostics.filter((d) => d.code === 'broken-crossref')
  assert.deepEqual(diagnostic!.range, { start: { line: 2, character: 4 }, end: { line: 2, character: 12 } })
})

test('a heading inside a list item reaches the outline, the inlay hints and the folds', () => {
  const source = '- item\n\n  ## In List\n\n  text\n'
  assert.deepEqual(analyzeCarve(source).symbols.map((symbol) => symbol.name), ['In List'])
  assert.deepEqual(inlayHints(source).map((hint) => hint.position.line), [2])
  assert.deepEqual(regions(source), [[2, 4]])
})

test('a heading inside a definition and a footnote body reaches the outline', () => {
  const source = ':: term\n:  def\n\n   ## In Def\n\nA note.[^1]\n\n[^1]: Body.\n\n    ## In Note\n'
  assert.deepEqual(analyzeCarve(source).symbols.map((symbol) => symbol.name), ['In Def', 'In Note'])
})

test('a fence in a list item folds, and so does a footnote body and its fence', () => {
  assert.ok(foldingRanges('- item\n\n  ```\n  a\n  b\n  ```\n').some((r) => r.startLine === 2 && r.endLine === 5))
  const note = foldingRanges('a[^1]\n\n[^1]: one\n\n  ```\n  a\n  b\n  ```\n')
  assert.ok(note.some((r) => r.startLine === 2 && r.endLine === 7), 'footnote body')
  assert.ok(note.some((r) => r.startLine === 4 && r.endLine === 7), 'fence in the footnote')
})

test('a section inside an admonition ends before its closer', () => {
  assert.deepEqual(regions('::: note\n## B\nx\n:::\n\npara after\n'), [[1, 2]])
})

test('a section inside a quote or a list item ends with it', () => {
  assert.deepEqual(regions('> ## Q\n> x\n\npara after\n\nmore\n'), [[0, 1]])
  assert.deepEqual(regions('- ## L\n  x\n- next\n\npara after\n'), [[0, 1]])
})

test('a closer of a child fence stays inside the section', () => {
  assert.deepEqual(regions('- ## H\n\n  ```\n  code\n  ```\n'), [[0, 4]])
  assert.deepEqual(regions('::: note\n## B\n\n::: box\ninner\n:::\n:::\n'), [[1, 5]])
})

test('a section ends before the attribute line of the next heading', () => {
  assert.deepEqual(regions('# A\n\ntext\n\n{#b}\n# B\n\nx\n'), [[0, 3], [5, 8]])
})

test('a section ends before the container holding its terminating heading', () => {
  assert.deepEqual(regions('## X\n\ntext\n\n::: note\n# Y\nbody\n:::\n'), [[0, 3], [5, 6]])
})

test('outline ranges span the section and contain their children', () => {
  const [a] = analyzeCarve('# A\n\ntext\n\n## B\n\nmore\n\n# C\n').symbols
  assert.deepEqual(a!.range, { start: { line: 0, character: 0 }, end: { line: 7, character: 0 } })
  assert.deepEqual(a!.selectionRange, { start: { line: 0, character: 0 }, end: { line: 0, character: 3 } })
  const b = a!.children![0]!
  assert.deepEqual(b.range, { start: { line: 4, character: 0 }, end: { line: 7, character: 0 } })
  assert.deepEqual(b.selectionRange, { start: { line: 4, character: 0 }, end: { line: 4, character: 4 } })
})

test('a heading after a closed container is not nested under the section that ended there', () => {
  const symbols = analyzeCarve('::: note\n# A\n:::\n\n## B\n').symbols
  assert.deepEqual(symbols.map((symbol) => [symbol.name, symbol.children?.length]), [['A', 0], ['B', 0]])
})

test('footnote bodies get semantic tokens', () => {
  const tokens = semanticTokens('a[^1]\n\n[^1]: has *bold* here\n')
  assert.ok(tokens.some((t) => t.line === 2 && t.character === 10 && t.length === 6 && t.type === 'keyword'))
})

test('quote markers are colored on every line, nested ones too', () => {
  const markers = (source: string) =>
    semanticTokens(source).filter((t) => t.type === 'operator').map((t) => [t.line, t.character, t.length])
  assert.deepEqual(markers('> a\n> b\n'), [[0, 0, 1], [1, 0, 1]])
  assert.deepEqual(markers('> > a\n> > b\n'), [[0, 0, 1], [0, 2, 1], [1, 0, 1], [1, 2, 1]])
  assert.deepEqual(markers('- > a\n  > b\n'), [[0, 0, 1], [0, 2, 1], [1, 2, 1]])
})

test('every list item marker is colored, the bare dot included', () => {
  const markers = (source: string) =>
    semanticTokens(source).filter((t) => t.type === 'operator').map((t) => [t.line, t.character, t.length])
  assert.deepEqual(markers('- a\n- b\n'), [[0, 0, 1], [1, 0, 1]])
  assert.deepEqual(markers('. one\n. two\n'), [[0, 0, 1], [1, 0, 1]])
  assert.deepEqual(markers('1. one\n2. two\n'), [[0, 0, 2], [1, 0, 2]])
})

test('a fenced quote colors its opener and closer', () => {
  const tokens = semanticTokens('::: >\nquote\n:::\n').map((t) => [t.line, t.character, t.length, t.type])
  assert.deepEqual(tokens, [[0, 0, 3, 'operator'], [0, 4, 1, 'operator'], [2, 0, 3, 'operator']])
})

test('admonition and div closers are colored', () => {
  const closer = (source: string) => semanticTokens(source).filter((t) => t.line === 2)
  assert.deepEqual(closer('::: note\nbody\n:::\n').map((t) => [t.character, t.length, t.type]), [[0, 3, 'operator']])
  assert.deepEqual(closer('::: box\nbody\n:::\n').map((t) => [t.character, t.length, t.type]), [[0, 3, 'operator']])
})

test('a long line of tokens keeps one token per span', () => {
  const tokens = semanticTokens('a *b* '.repeat(2000) + '\n')
  assert.equal(tokens.length, 2000)
  assert.deepEqual([tokens[1999]!.character, tokens[1999]!.length], [11996, 3])
})

test('the shared parse is reused and no feature mutates it', () => {
  clearParseCache()
  const source = '# A\n\n- item\n\n  ## In List\n\na[^1]\n\n[^1]: note *x*\n\n> q\n'
  const doc = resolvedDocument(source)
  const snapshot = JSON.stringify(doc)
  analyzeCarve(source)
  foldingRanges(source)
  inlayHints(source)
  semanticTokens(source)
  assert.equal(resolvedDocument(source), doc)
  assert.equal(JSON.stringify(doc), snapshot)
  assert.notEqual(resolvedDocument(`${source}x\n`), doc)
})
