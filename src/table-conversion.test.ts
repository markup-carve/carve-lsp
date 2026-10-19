import test from 'node:test'
import assert from 'node:assert/strict'
import { csvTableToPipe, pipeTableToCsv, isLosslessRewrite, tableConversionCodeActions } from './table-conversion.js'

const sample = '{table}\n```csv\nPlan,Seats,Price per month\nStarter,1,"$0"\nTeam,10,"$49, billed yearly"\n```\n'
const expected = '|= Plan   |= Seats |= Price per month   |\n| Starter | 1      | $0                 |\n| Team    | 10     | $49, billed yearly |'

test('converts and aligns the maintainer sample', () => {
  assert.equal(csvTableToPipe(sample, 0)?.newText, expected)
  assert.equal(csvTableToPipe(sample, 5)?.newText, expected)
  assert.equal(tableConversionCodeActions('file:///x', sample, 1)[0]?.title, 'Convert to pipe table')
})

test('preserves quoted commas and doubled quotes', () => {
  const source = '{table}\n```csv\na,b\n"x,y","say ""hi"""\n```\n'
  const edit = csvTableToPipe(source, 2)
  assert.ok(edit)
  assert.match(edit.newText, /x,y/)
  assert.match(edit.newText, /\\"hi\\"/)
  assert.ok(isLosslessRewrite(source, edit.newText + '\n'))
})

test('escapes markup, pipes, and backticks', () => {
  const source = '{table}\n```csv\na,b,c\n*bold*,a|b,`code`\n```\n'
  const edit = csvTableToPipe(source, 3)
  assert.ok(edit)
  assert.match(edit.newText, /\\\*bold\\\*/)
  assert.match(edit.newText, /a\\\|b/)
  assert.match(edit.newText, /\\`code\\`/)
  assert.ok(isLosslessRewrite(source, edit.newText + '\n'))
})

test('escapes comments, attributes, links and lone span markers', () => {
  const source = '{table}\n```csv\na,b,c,d\nx %% y,{.c} z,[r],<\n```\n\n[r]: https://example.com\n'
  const edit = csvTableToPipe(source, 0)
  assert.ok(edit)
  const result = source.slice(0, edit.startOffset) + edit.newText + source.slice(edit.endOffset)
  assert.ok(isLosslessRewrite(source, result))
  assert.match(edit.newText, /\\%\\%/)
  assert.match(edit.newText, /\| \\< \|/)
})

test('moves the table flag out of a later position in the attribute line', () => {
  assert.equal(csvTableToPipe('{.wide table}\n```csv\na,b\n1,2\n```\n', 0)?.newText, '{.wide}\n|= a |= b |\n| 1  | 2  |')
})

test('refuses multiline fields', () => {
  assert.equal(csvTableToPipe('{table}\n```csv\na,b\n"one\ntwo",x\n```\n', 3), null)
})

test('refuses a field whose edge spaces a pipe cell would trim', () => {
  assert.equal(csvTableToPipe('{table}\n```csv\na,b\n" x ",2\n```\n', 0), null)
})

test('converts TSV and carries attributes and caption', () => {
  const tsv = '{table .wide #t aligns=left,right}\n```tsv\na\tb\nc\td\n```\n^ Cap\n'
  const edit = csvTableToPipe(tsv, 5)
  assert.ok(edit)
  assert.match(edit.newText, /^\{\.wide #t aligns=left,right\}\n/)
  assert.match(edit.newText, /\n\^ Cap$/)
})

test('converts plain pipe tables and refuses markup and cell attributes', () => {
  const source = '|= Plan |= Seats |\n| Starter | 1 |\n'
  assert.equal(pipeTableToCsv(source, 0)?.newText, '{table}\n```csv\nPlan,Seats\nStarter,1\n```')
  assert.equal(pipeTableToCsv('| *x* | y |\n', 0), null)
  assert.equal(pipeTableToCsv('|= a |= b |\n| x |> y |\n', 0), null)
  assert.equal(pipeTableToCsv('|= a |= b |\n|= x | y |\n', 0), null)
  assert.equal(pipeTableToCsv('|= a |\n| x\\|y |\n', 0)?.newText, '{table}\n```csv\na\nx|y\n```')
  assert.equal(pipeTableToCsv('{.wide}\n| a, b | c |\n^ Cap\n', 0)?.newText, '{table .wide header-rows=0}\n```csv\n"a, b",c\n```\n^ Cap')
})

test('preserves CRLF and rejects a mutated conversion', () => {
  const source = sample.replace(/\n/g, '\r\n')
  const edit = csvTableToPipe(source, 2)
  assert.ok(edit)
  assert.doesNotMatch(edit.newText, /(?<!\r)\n/)
  assert.equal(isLosslessRewrite(sample, expected.replace('Starter', 'Changed') + '\n'), false)
  assert.equal(isLosslessRewrite(sample, expected + '\n'), true)
})

test('mutation control: the guard refuses a converter that skips escaping', () => {
  const source = '{table}\n```csv\na,b\n*bold*,x %% y\n```\n'
  const edit = csvTableToPipe(source, 0)
  assert.ok(edit)
  const unescaped = edit.newText.replace(/\\(.)/g, '$1') + '\n'
  assert.notEqual(unescaped, edit.newText + '\n')
  assert.equal(isLosslessRewrite(source, unescaped), false)
  assert.equal(isLosslessRewrite(source, edit.newText + '\n'), true)
  assert.deepEqual(tableConversionCodeActions('file:///x', 'A paragraph\n', 0), [])
})
