import test from 'node:test'
import assert from 'node:assert/strict'
import { analyzeCarve } from './analyze.js'
import { tableDiagnostics } from './table-diagnostics.js'

const codes = (source: string) => analyzeCarve(source).diagnostics.map((item) => item.code).filter((code) => String(code).startsWith('table-'))

test('reports each #1344 table diagnostic once, from the engine or this pass', () => {
  assert.deepEqual(codes('{aligns="left" widths="60,50"}\n|=> Head | Other |\n|>body | x |\n').sort(),
    ['table-alignment-run-padding', 'table-column-arity', 'table-column-overlap', 'table-width-total'])
  assert.deepEqual(codes('| x |<c |>d |\n'), ['table-alignment-run-padding', 'table-alignment-run-padding'])
})

test('flags more positional entries than columns', () => {
  const [arity] = tableDiagnostics('{aligns="left,right,center"}\n| a | b |\n')
  assert.equal(arity?.code, 'table-column-arity')
  assert.deepEqual(arity?.range, { start: { line: 0, character: 1 }, end: { line: 0, character: 27 } })
})

test('reads tables from the AST: code spans, quotes, fences and comments', () => {
  // A pipe in a code span is cell content, not a column.
  assert.equal(tableDiagnostics('{aligns="left,right"}\n| a | `x|y` |\n').length, 0)
  assert.equal(tableDiagnostics('> {aligns="left,right,center"}\n> | a | b |\n')[0]?.range.start.character, 3)
  assert.deepEqual(tableDiagnostics('```\n{aligns="left,right,center"}\n| a | b |\n```\n'), [])
  assert.deepEqual(tableDiagnostics('%%%\n{aligns="left,right,center"}\n| a | b |\n%%%\n'), [])
  assert.deepEqual(codes('```\n| x |<c |\n```\n'), [])
})
