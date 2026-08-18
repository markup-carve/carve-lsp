import test from 'node:test'
import assert from 'node:assert/strict'
import { selectionRanges } from './selection.js'

test('expands identifier to line to document', () => {
  const selected = selectionRanges('file:///a.crv', 'See [^note].\n\nTail.\n', [{ line: 0, character: 7 }])[0]!
  assert.equal(selected.range.start.character, 6)
  assert.equal(selected.parent?.range.end.character, 12)
  assert.equal(selected.parent?.parent?.range.end.line, 3)
})
