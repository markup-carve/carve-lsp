import assert from 'node:assert/strict'
import test from 'node:test'
import { completionAt } from './completion.js'

const labels = (source: string, line: number, character: number): string[] =>
  completionAt(source, { line, character }).map((item) => item.label)

test('suggests admonition kinds after a colon fence', () => {
  const items = labels(':::', 0, 3)
  assert.ok(items.includes('note'))
  assert.ok(items.includes('warning'))
})

test('suggests heading ids for a cross-reference', () => {
  const source = '# Hello World\n\n</#'
  // carve-js derives case-preserving heading ids (spaces -> hyphens).
  assert.deepEqual(labels(source, 2, 3), ['Hello-World'])
})

test('suggests defined footnote labels', () => {
  const source = 'text[^a]\n\n[^a]: note\n\n[^'
  assert.deepEqual(labels(source, 4, 2), ['a'])
})

test('suggests link reference labels', () => {
  const source = '[site]: https://example.com\n\nsee [text]['
  assert.deepEqual(labels(source, 2, 11), ['site'])
})

test('suggests bare empty link reference labels', () => {
  const source = '[r]:\n\nsee [x]['
  assert.deepEqual(labels(source, 2, 8), ['r'])
})

test('trims trailing tabs and excludes reserved bare labels', () => {
  const source = '[r]:\t\n[@k]:\n[^fn]:\n\nsee [x]['
  assert.deepEqual(labels(source, 4, 8), ['r'])
})

test('does not offer footnote definitions as link references', () => {
  const source = '[site]: https://example.com\n[^fn]: a footnote\n\nsee [text]['
  assert.deepEqual(labels(source, 3, 11), ['site'])
})

test('returns nothing in plain prose', () => {
  assert.deepEqual(labels('just some text', 0, 9), [])
})

test('completion replaces the typed partial', () => {
  const items = completionAt('</#hel', { line: 0, character: 6 })
  // Nothing to complete against (no headings) -> empty, but must not throw.
  assert.deepEqual(items, [])
})

test('suggests citation keys, semantic spans, and structural attributes', () => {
  assert.deepEqual(labels('[@doc]: Entry\n\n[@do', 2, 4), ['doc'])
  assert.ok(labels('[Tab]{k', 0, 7).includes('kbd'))
  const attrs = labels('{vali', 0, 5)
  assert.ok(attrs.includes('valign='))
  assert.ok(attrs.includes('valigns='))
})

test('an include directive offers no attribute or span completions', () => {
  for (const prefix of ['{{ ', '{{ chapter', '{{ ch.crv #', 'text {{ a.crv lines=']) {
    assert.deepEqual(labels(prefix, 0, prefix.length), [], prefix)
  }
  // A closed directive gives the attribute slot after it back.
  assert.ok(labels('{{ a.crv }}{.', 0, 13).includes('.class'))
  assert.ok(labels('{.', 0, 2).includes('.class'))
})

test('a colon fence offers placement markers and extension containers', () => {
  const items = completionAt('::: ', { line: 0, character: 4 })
  const detail = (label: string) => items.find((item) => item.label === label)?.detail
  for (const kind of ['toc', 'footnotes', 'references', 'bibliography', 'glossary', 'index']) assert.equal(detail(kind), 'Placement marker', kind)
  for (const kind of ['details', 'spoiler', 'tabs', 'tab', 'list-table', 'code-group']) assert.equal(detail(kind), 'Extension container', kind)
  assert.equal(detail('note'), 'Admonition kind')
  assert.equal(detail('>'), 'Fenced block quote')
  assert.equal(detail('|'), 'Line block')
  assert.equal(detail('\\'), 'Hard-break block')
  // Once a word is started the symbol forms no longer apply.
  assert.deepEqual(labels('::: de', 0, 6).filter((label) => !/^[\w-]+$/.test(label)), [])
})

test('a code fence opener offers languages and raw formats', () => {
  for (const prefix of ['```', '``` ', '~~~', '````', '> ```', '  ```']) {
    const items = labels(prefix, 0, prefix.length)
    for (const language of ['javascript', 'python', 'mermaid', '=html']) assert.ok(items.includes(language), `${prefix} ${language}`)
  }
  const partial = completionAt('```py', { line: 0, character: 5 }).find((item) => item.label === 'python')
  assert.deepEqual(partial?.textEdit, { range: { start: { line: 0, character: 3 }, end: { line: 0, character: 5 } }, newText: 'python' })
  assert.deepEqual(labels('```=', 0, 4), ['=html', '=latex'])
  // Inside an open code block a fence-shaped line is code, and inline code is not a fence.
  assert.deepEqual(labels('```\nx\n```', 2, 3), [])
  assert.deepEqual(labels('```js\nx\n```p', 2, 4), [])
  assert.deepEqual(labels('a ```', 0, 5), [])
})

test('link text offers heading titles as a collapsed reference', () => {
  const source = '# My Head\n\n## Other *Part*\n\nsee [My'
  const items = completionAt(source, { line: 4, character: 7 })
  assert.deepEqual(items.map((item) => item.label), ['My Head'])
  assert.deepEqual(items[0]!.textEdit, { range: { start: { line: 4, character: 5 }, end: { line: 4, character: 7 } }, newText: 'My Head][]' })
  // Case-insensitive prefix; inline markup reads as its text.
  assert.deepEqual(labels(source.replace('[My', '[oth'), 4, 8), ['Other Part'])
  // An auto-closed `]` after the cursor is replaced, not doubled.
  const closed = completionAt(`${source}]`, { line: 4, character: 7 })
  assert.equal(closed[0]!.textEdit && 'range' in closed[0]!.textEdit ? closed[0]!.textEdit.range.end.character : -1, 8)
})

test('heading titles are not offered on a bare bracket or other bracket forms', () => {
  const source = '# My Head\n\n'
  for (const text of ['see [', 'see [ M', 'see ![My', 'see [[My', 'see \\[My', 'see [zzz', 'see [My Head](#x', 'see [^My', 'see [@My']) {
    assert.deepEqual(labels(source + text, 2, text.length).filter((label) => label === 'My Head'), [], text)
  }
  // Brackets that already carry a destination, reference or attributes are left alone.
  for (const text of ['see [My](url)', 'see [My][]', 'see [My][ref]', 'see [My]{.c}', 'see [My x](url)', 'see [My x]']) {
    assert.deepEqual(labels(source + text, 2, 7), [], text)
  }
})
