import assert from 'node:assert/strict'
import test from 'node:test'
import { formatDocument } from './format.js'

test('strips trailing whitespace and enforces a final newline', () => {
  assert.equal(formatDocument('# Title   \n\npara\t'), '# Title\n\npara\n')
})

test('collapses runs of blank lines to a single blank line', () => {
  assert.equal(formatDocument('a\n\n\n\nb'), 'a\n\nb\n')
})

test('trims leading and trailing blank lines', () => {
  assert.equal(formatDocument('\n\n# Title\n\n\n'), '# Title\n')
})

test('preserves verbatim interiors of fenced code blocks', () => {
  const src = '```js\ncode   \n\n\n  more\n```\n'
  // Trailing spaces and blank runs inside the fence are untouched.
  assert.equal(formatDocument(src), src)
})

test('still normalizes outside a closed fence', () => {
  const src = '```\nx\n```\n\n\n\ntail   \n'
  assert.equal(formatDocument(src), '```\nx\n```\n\ntail\n')
})

test('handles nested longer fences without closing early', () => {
  const src = '````md\n```\ninner   \n```\n````\n'
  assert.equal(formatDocument(src), src)
})

test('a 4-space-indented fence does not close a code block', () => {
  const src = '```\ncode\n    ```\n```\n\n\n\ntail   \n'
  // The indented ``` stays inside the block; the flush ``` closes it; only the
  // prose after the block is normalized.
  assert.equal(formatDocument(src), '```\ncode\n    ```\n```\n\ntail\n')
})

test('comment block closes only on an exact-length marker', () => {
  const src = '%%%\nhidden   \n%%%%\nstill   \n%%%\n'
  // %%%% (len 4) does not close %%% (len 3); the block runs to the matching %%%.
  assert.equal(formatDocument(src), src)
})

test('a backtick line with inline backticks is not a fence', () => {
  // Not a real opener, so trailing whitespace after it is still trimmed.
  const src = '``` not `a` fence   \nbody   \n'
  assert.equal(formatDocument(src), '``` not `a` fence\nbody\n')
})

test('is idempotent', () => {
  const once = formatDocument('# T  \n\n\n\nbody  \n')
  assert.equal(formatDocument(once), once)
})
