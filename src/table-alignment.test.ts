import test from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { alignTableCodeAction, alignTablesInDocument, tableAlignmentEdits } from './table-alignment.js'
import { format, render } from './engine.js'

const canonical = '|= Name |= Score |\n| 山田太郎 | 10 |\n'
const aligned = '|= Name    |= Score |\n| 山田太郎 | 10     |\n'

// The 0.1 spec fixtures (carve 51c5631 `resources/spec/table-alignment-fixtures.json`); carve `next2` no longer carries them.
const specFixtures = JSON.parse(readFileSync(new URL('../tests/fixtures/table-alignment-fixtures.json', import.meta.url), 'utf8')) as
  { name: string, canonical: string, aligned: string }[]

// 0.1 spec fixtures whose canonical form the 0.2 writer changes; each still matches 0.2 `format` with `alignTables` below.
const CHANGED_IN_0_2: Record<string, string> = {
  'attributes spans and empty cells': '0.2 C2-B-171, C2-B-182: the writer escapes a cell that starts with `<`',
  'authored separator': '0.2 U-055: a GFM separator row is an ordinary row and pads like one',
  'separator colons': '0.2 U-055: a GFM separator row is an ordinary row and pads like one',
  'rowspan continuation': '0.2 C2-B-173, C2-B-184: a continuation fragment under a span mark joins the spanning cell',
}

for (const fixture of specFixtures) {
  test(`aligns the spec fixture like 0.2 format: ${fixture.name}`, () => {
    assert.equal(alignTablesInDocument(fixture.canonical), format(fixture.canonical, { alignTables: true }))
  })
  test(`matches the spec fixture: ${fixture.name}`, { skip: CHANGED_IN_0_2[fixture.name] ?? false }, () => {
    assert.equal(alignTablesInDocument(fixture.canonical), fixture.aligned)
    assert.equal(alignTablesInDocument(fixture.aligned), fixture.aligned)
    assert.equal(render(fixture.aligned), render(fixture.canonical))
  })
}

test('aligns only table rows and preserves surrounding source', () => {
  const source = '# Title\n\n' + canonical + '\nText\n'
  assert.equal(alignTablesInDocument(source), '# Title\n\n' + aligned + '\nText\n')
  assert.equal(alignTablesInDocument(alignTablesInDocument(source)), alignTablesInDocument(source))
})

test('finds a table in quote and list containers', () => {
  const quoted = '> ' + canonical.trimEnd().split('\n').join('\n> ') + '\n'
  const quotedAligned = '> ' + aligned.trimEnd().split('\n').join('\n> ') + '\n'
  assert.equal(alignTablesInDocument(quoted), quotedAligned)
  const listed = '- item\n  ' + canonical.trimEnd().split('\n').join('\n  ') + '\n'
  const listedAligned = '- item\n  ' + aligned.trimEnd().split('\n').join('\n  ') + '\n'
  assert.equal(alignTablesInDocument(listed), listedAligned)
})

test('keeps mixed line endings outside and inside a table', () => {
  const source = '# Title\r\n\r\n|= Name |= Score |\n| 山田太郎 | 10 |\r\n\r\nText\n'
  const expected = '# Title\r\n\r\n|= Name    |= Score |\n| 山田太郎 | 10     |\r\n\r\nText\n'
  assert.equal(alignTablesInDocument(source), expected)
})

test('matches the Unicode width rule across continuation and separator rows', () => {
  const source = '|= Name |= Score |= Note |\n| Ada | 9 | first try |\n| 山田太郎 | 10 | a longer note |\n+ | | that wraps |\n| Total | 19 | < |\n'
  const expected = '|= Name    |= Score |= Note         |\n| Ada      | 9      | first try     |\n| 山田太郎 | 10     | a longer note |\n+          |        | that wraps    |\n| Total    | 19     | <             |\n'
  assert.equal(alignTablesInDocument(source), expected)
  assert.equal(render(alignTablesInDocument(source)), render(source))
  assert.equal(alignTablesInDocument(expected), expected)

  // 0.2 U-055: a GFM separator row is an ordinary row and pads like one.
  const separator = '| A | B |\n|---|---|\n| x | yy |\n'
  assert.equal(alignTablesInDocument(separator), '| A   | B   |\n| --- | --- |\n| x   | yy  |\n')
})

test('keeps escaped pipes, row attributes, and captions in their own slots', () => {
  const source = '| a\\|b | c |{#row}\n| x | longer |\n^ Caption\n'
  const expected = '| a\\|b | c      |{#row}\n| x    | longer |\n^ Caption\n'
  assert.equal(alignTablesInDocument(source), expected)
  assert.equal(alignTablesInDocument(expected), expected)
})

test('keeps a pipe inside inline code in the same cell', () => {
  const source = '| `a|b` | c |\n| xxxxxxxx | d |\n'
  const aligned = alignTablesInDocument(source)
  assert.equal(render(aligned), render(source))
  assert.match(aligned, /`a\|b`/)
  assert.equal(alignTablesInDocument(aligned), aligned)
})

test('canonicalizes table cells before padding', () => {
  const headers = '|= a |= b |\n|:--|--:|\n| c | dd |\n'
  const alignedHeaders = alignTablesInDocument(headers)
  assert.equal(render(alignedHeaders), render(headers))
  assert.equal(alignTablesInDocument(alignedHeaders), alignedHeaders)
  const tab = '|\ta | b |\n| x | longer |\n'
  const alignedTab = alignTablesInDocument(tab)
  assert.equal(render(alignedTab), render(tab))

  const stalePadding = '| a      | b |\n| c | d |\n'
  const normalized = alignTablesInDocument(stalePadding)
  assert.equal(normalized, '| a | b |\n| c | d |\n')
  assert.equal(alignTablesInDocument(normalized), normalized)
})

test('aligns rows with literal or escaped backticks', () => {
  for (const firstRow of ['| \\` | a |', '| `x | a |']) {
    const source = firstRow + '\n| bbbbbb | c |\n'
    const aligned = alignTablesInDocument(source)
    assert.equal(render(aligned), render(source))
    if (firstRow.includes('\\`')) assert.notEqual(aligned, source)
  }
})

test('a backslash inside code does not hide its closing backtick', () => {
  const source = '| `\\` | `x` |\n| a | b |\n'
  const aligned = alignTablesInDocument(source)
  assert.equal(render(aligned), render(source))
  assert.equal(alignTablesInDocument(aligned), aligned)
  assert.match(aligned, /\| a\s+\| b/)
})

test('aligns a table that begins on a list marker line', () => {
  const source = '- | a | b |\n  | ccc | d |\n'
  const aligned = alignTablesInDocument(source)
  assert.equal(render(aligned), render(source))
  assert.match(aligned, /^- \| a   \|/)
  assert.match(aligned, /^  \| ccc \|/m)
})

test('offers one table action at the selected line', () => {
  const source = '# Title\n\n' + canonical + '\nText\n'
  assert.equal(alignTableCodeAction('file:///table.crv', source, 0), null)
  const action = alignTableCodeAction('file:///table.crv', source, 3)
  assert.equal(action?.title, 'Align table')
  assert.deepEqual(action?.edit?.changes?.['file:///table.crv'], tableAlignmentEdits(source, 3, 3).map(edit => edit.textEdit))
  assert.equal(tableAlignmentEdits(source, 0, 0).length, 0)
})
