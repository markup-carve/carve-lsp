import assert from 'node:assert/strict'
import test from 'node:test'
import { carveToHtml } from '@markup-carve/carve'
import { continuationPrefix, formatDocument, formatRange } from './format.js'

test('adds a missing final line ending', () => {
  assert.equal(formatDocument('# Title'), '# Title\n')
  assert.equal(formatDocument('# Title\r\nbody'), '# Title\r\nbody\r\n')
})

test('preserves an empty document and existing final line endings', () => {
  assert.equal(formatDocument(''), '')
  assert.equal(formatDocument('# Title\n'), '# Title\n')
  assert.equal(formatDocument('# Title\r\n'), '# Title\r\n')
})

test('preserves a blank-line run that detaches a caption', () => {
  const source = '|= City |= People |\n| Oslo  | 700k   |\n\n\n^ Table: city sizes\n'
  assert.equal(formatDocument(source), source)
})

test('preserves a trailing blank line inside an unclosed fence', () => {
  const source = '```\nx\n\n'
  assert.equal(formatDocument(source), source)
})

test('preserves trailing spaces in a line block', () => {
  const source = '::: |\nabc  \ndef \n:::\n'
  assert.equal(formatDocument(source), source)
})

test('range formatting preserves structural whitespace', () => {
  assert.equal(formatRange('a  \n\n\nb \n', 0, 3), 'a  \n\n\nb ')
})

test('continues structural prefixes', () => {
  assert.equal(continuationPrefix('> q\n', 1), '> ')
  assert.equal(continuationPrefix('| a |\n', 1), '| ')
})

test('inserts an exact closer after a typed colon-fence opener', () => {
  assert.equal(continuationPrefix(':::: warning\n', 1), '\n::::')
  assert.equal(continuationPrefix('  ::: note\n', 1), '\n  :::')
  assert.equal(continuationPrefix(':::\n', 1), '')
})

// The document right after Enter at the end of `before`, with `after` below the cursor.
function prefixAfter(before: string, after = ''): string {
  return continuationPrefix(`${before}\n${after === '' ? '' : `\n${after}`}`, before.split('\n').length)
}

test('no second closer for a colon-fence opener that is already closed', () => {
  assert.equal(prefixAfter('::: note', 'x\n:::'), '')
  assert.equal(prefixAfter('::: note', '\n:::\n'), '')
  assert.equal(prefixAfter('::: note', ':::'), '')
  assert.equal(prefixAfter(':::: outer\n::: note', 'x\n:::\n::::'), '')
  // An unclosed inner opener inside a closed outer one still gets its own closer.
  assert.equal(prefixAfter(':::: outer\n::: note', '::::'), '\n:::')
  assert.equal(prefixAfter('::: note\n:::\n\n::: tip', ''), '\n:::')
  // An opener-shaped line in code is text.
  assert.equal(prefixAfter('```\n::: note', '```'), '')
  // Enter that split the line leaves no room for a closer.
  assert.equal(continuationPrefix('::: note\nrest', 1), '')
})

test('inserts a matching closer after a code fence opener', () => {
  for (const [before, closer] of [
    ['```js', '\n```'],
    ['```', '\n```'],
    ['~~~', '\n~~~'],
    ['````js', '\n````'],
    ['~~~~ py "title" [lbl]', '\n~~~~'],
    ['```js "t"', '\n```'],
    ['``` =html', '\n```'],
    ['::: note\n```js', '\n```'],
    ['- a\n\n  ```js', '\n  ```'],
  ] as const) assert.equal(prefixAfter(before), closer, before)
  // The closer lands as the block's own closing fence.
  const html = carveToHtml('```js\nx' + prefixAfter('```js') + '\n')
  assert.equal(html, '<pre><code class="language-js">x\n</code></pre>')
})

test('no closer for a closed fence, a closing fence or a fence line inside code', () => {
  assert.equal(prefixAfter('```js', 'x\n```'), '')
  assert.equal(prefixAfter('~~~', 'x\n~~~~'), '')
  // A bare fence that closes the block above is a closer, not an opener.
  assert.equal(prefixAfter('```\nx\n```'), '')
  assert.equal(prefixAfter('~~~\nx\n~~~'), '')
  // An info string never closes a block, so this line is code.
  assert.equal(prefixAfter('```\n```js', '```'), '')
  assert.equal(prefixAfter('````\n```js'), '')
  // After a closed block, a bare fence opens a new one.
  assert.equal(prefixAfter('```\nx\n```\n```'), '\n```')
  // Inline code, and fences in a quote, are left to the other continuations.
  assert.equal(prefixAfter('a\n```'), '')
  assert.equal(prefixAfter('> ```js'), '> ')
  assert.equal(continuationPrefix('```js\nrest', 1), '')
})

test('is idempotent', () => {
  const once = formatDocument('# T')
  assert.equal(formatDocument(once), once)
})
