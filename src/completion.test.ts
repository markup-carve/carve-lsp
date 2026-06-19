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
