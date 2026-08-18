import test from 'node:test'
import assert from 'node:assert/strict'
import { tableDiagnostics } from './table-diagnostics.js'

test('diagnoses #1344 padding, arity, overlap, and width totals', () => {
  const source = '{aligns="left" widths="60,50"}\n|=>Head | Other |\n|>body | x |\n'
  const codes = tableDiagnostics(source).map((item) => item.code)
  assert.ok(codes.includes('table-alignment-run-padding'))
  assert.ok(codes.includes('table-column-arity'))
  assert.ok(codes.includes('table-column-overlap'))
  assert.ok(codes.includes('table-width-total'))
})
