import test from 'node:test'
import assert from 'node:assert/strict'
import { colonFenceHover, colonFenceInlayHints, colonFenceStructure, linkedColonFenceRanges } from './colon-fences.js'

test('reports a near closer with widths, opener, and actual outcome', () => {
  const [found] = colonFenceStructure(':::: note\nbody\n:::\n').diagnostics
  assert.equal(found?.code, 'colon-fence-length-mismatch')
  assert.deepEqual(found?.data, { authoredWidth: 3, expectedWidth: 4, openerLine: 1, openerColumn: 1, outcome: 'nested container' })
})

test('does not report exact, typed, escaped, deliberate nested, or opaque runs', () => {
  for (const source of [
    ':::: note\n::::\n', ':::: note\n::: tip\n:::\n::::\n',
    ':::: note\n\\:::\n::::\n', ':::: note\n:::\nx\n:::\n::::\n',
    ':::: note\n```\n:::\n```\n::::\n', ':::: note\n%%%\n:::\n%%%\n::::\n',
  ]) assert.deepEqual(colonFenceStructure(source).diagnostics, [])
})

test('exposes exact pairs for linked editing, hover, and nesting hints', () => {
  const source = ':::: warning\nbody\n::::\n'
  assert.equal(linkedColonFenceRanges(source, { line: 0, character: 2 })?.ranges.length, 2)
  assert.match(String((colonFenceHover(source, { line: 2, character: 2 })?.contents as { value: string }).value), /warning admonition/)
  assert.equal(colonFenceInlayHints(source, { start: { line: 0, character: 0 }, end: { line: 3, character: 0 } }).length, 1)
})
