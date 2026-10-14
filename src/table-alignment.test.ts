import test from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { alignTableCodeAction, alignTablesInDocument, tableAlignmentEdits } from './table-alignment.js'
import { carveToHtml } from '@markup-carve/carve'

const canonical = '|= Name |= Score |\n| 山田太郎 | 10 |\n'
const aligned = '|= Name    |= Score |\n| 山田太郎 | 10     |\n'

const specFixtures = JSON.parse(readFileSync(new URL('../tests/spec/resources/spec/table-alignment-fixtures.json', import.meta.url), 'utf8')) as
  { name: string, canonical: string, aligned: string }[]

for (const fixture of specFixtures) {
  test(`matches the spec fixture: ${fixture.name}`, () => {
    assert.equal(alignTablesInDocument(fixture.canonical), fixture.aligned)
    assert.equal(alignTablesInDocument(fixture.aligned), fixture.aligned)
    assert.equal(carveToHtml(fixture.aligned), carveToHtml(fixture.canonical))
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
  assert.equal(carveToHtml(alignTablesInDocument(source)), carveToHtml(source))
  assert.equal(alignTablesInDocument(expected), expected)

  const separator = '| A | B |\n|---|---|\n| x | yy |\n'
  assert.equal(alignTablesInDocument(separator), '| A | B  |\n|---|--- |\n| x | yy |\n')
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
  assert.equal(carveToHtml(aligned), carveToHtml(source))
  assert.match(aligned, /`a\|b`/)
  assert.equal(alignTablesInDocument(aligned), aligned)
})

test('aligns a table that begins on a list marker line', () => {
  const source = '- | a | b |\n  | ccc | d |\n'
  const aligned = alignTablesInDocument(source)
  assert.equal(carveToHtml(aligned), carveToHtml(source))
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
