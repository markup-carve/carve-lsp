import assert from 'node:assert/strict'
import test from 'node:test'
import { foldingRanges } from './folding.js'

const src = '# A\n\ntext\n\n## B\n\nmore\n\n```js\none\ntwo\n```\n'

test('folds the section under a top-level heading', () => {
  const ranges = foldingRanges(src)
  assert.ok(ranges.some((r) => r.startLine === 0 && r.endLine >= 11), 'H1 section fold')
})

test('folds a nested subsection', () => {
  const ranges = foldingRanges(src)
  assert.ok(ranges.some((r) => r.startLine === 4), 'H2 section fold')
})

test('folds a multi-line fenced code block', () => {
  const ranges = foldingRanges(src)
  assert.ok(ranges.some((r) => r.startLine === 8 && r.endLine === 11), 'code block fold')
})

test('returns nothing for an empty document', () => {
  assert.deepEqual(foldingRanges(''), [])
})
