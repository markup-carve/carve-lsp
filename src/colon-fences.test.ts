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

const pairLines = (source: string) => colonFenceStructure(source).pairs
  .map(({ opener, closer }) => [opener.range.start.line, closer.range.start.line, closer.range.start.character])
  .sort((a, b) => a[0]! - b[0]!)

test('a container inside a block quote pairs with its quoted closer', () => {
  assert.deepEqual(pairLines('> ::: note\n> x\n> :::\n'), [[0, 2, 2]])
  assert.deepEqual(pairLines('> > ::: note\n> > x\n> > :::\n'), [[0, 2, 4]])
  assert.deepEqual(pairLines('> - ::: note\n>   x\n>   :::\n'), [[0, 2, 4]])
  assert.deepEqual(pairLines('> ::: note\n> ::: tip\n> x\n> :::\n> :::\n'), [[0, 4, 2], [1, 3, 2]])
  assert.deepEqual(pairLines('> ::: note\n>\n> x\n> :::\n'), [[0, 3, 2]])
  const source = '> ::: warning\n> body\n> :::\n'
  assert.match(String((colonFenceHover(source, { line: 2, character: 3 })?.contents as { value: string }).value), /warning admonition/)
  assert.equal(linkedColonFenceRanges(source, { line: 2, character: 3 })?.ranges.length, 2)
})

test('a quoted container does not pair across the end of its quote', () => {
  for (const source of [
    '> ::: note\n> x\n:::\n', '> ::: note\n> x\n\n> :::\n', '> > ::: note\n> > x\n> :::\n', '> ::: note\n> x\n>:::\n',
  ]) assert.deepEqual(pairLines(source).filter(([opener]) => opener === 0), [], source)
  // The quote ends the inner container, so the bare run closes the outer one.
  assert.deepEqual(pairLines('::: note\n> ::: tip\n> x\n\n:::\n'), [[0, 4, 0]])
})

test('a container with invalid metadata still pairs with its closer', () => {
  // An unquoted title is dropped, but the container keeps its subtree (corpus 537).
  const source = '::: note Custom Title\nbody\n:::\n'
  assert.deepEqual(pairLines(source), [[0, 2, 0]])
  assert.equal(linkedColonFenceRanges(source, { line: 0, character: 1 })?.ranges.length, 2)
})

test('a fence opened on a footnote label pairs with the closer at the body indent', () => {
  assert.deepEqual(pairLines('x[^1]\n\n[^1]: ::: note\n  body\n  :::\n'), [[2, 4, 2]])
  assert.deepEqual(pairLines('x[^long]\n\n> [^long]: ::: note\n>   body\n>   :::\n'), [[2, 4, 4]])
})

test('fence columns are UTF-16 after an astral character', () => {
  const source = 'x[^🎉]\n\n[^🎉]: ::: note\n  body\n  :::\n'
  const [opener] = colonFenceStructure(source).openers
  assert.deepEqual(opener?.range, { start: { line: 2, character: 7 }, end: { line: 2, character: 10 } })
  assert.deepEqual(pairLines(source), [[2, 4, 2]])
})
