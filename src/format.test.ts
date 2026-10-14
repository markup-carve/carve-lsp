import assert from 'node:assert/strict'
import test from 'node:test'
import { carveToHtml } from '@markup-carve/carve'
import { continuationEdits, continuationPrefix, formatDocument, formatRange, listContinuationEdits } from './format.js'

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
  // An indented top-level `:::` is literal text (corpus 160), so it gets no closer.
  assert.equal(continuationPrefix('  ::: note\n', 1), '')
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

test('lines of code, raw and comment blocks get no container continuation', () => {
  assert.equal(prefixAfter('```\n> x'), '')
  assert.equal(prefixAfter('```\n| a'), '')
  assert.equal(prefixAfter('```\n: x'), '')
  assert.equal(prefixAfter('%%%\n> x', '%%%'), '')
  assert.equal(prefixAfter('```=html\n| a', '```'), '')
  // The container the block sits in still continues, and an opener still gets its closer.
  assert.equal(prefixAfter('> ```\n> x'), '> ')
  assert.equal(prefixAfter('```'), '\n```')
})

test('a colon fence opened in a container writes the lead before the cursor and the closer after it', () => {
  for (const [before, expected] of [
    ['> ::: note', '> \n> :::'],
    ['> > :::: warning', '> > \n> > ::::'],
    ['- ::: note', '  \n  :::'],
    ['1. ::: note', '   \n   :::'],
    ['- a\n\n  ::: note', '  \n  :::'],
    ['[^1]: ::: note', '  \n  :::'],
    ['::: note', '\n:::'],
  ] as const) {
    assert.equal(prefixAfter(before), expected, before)
    // The body typed at the cursor lands inside the container.
    const [lead, closer] = expected.split('\n')
    const html = carveToHtml(`x[^1]\n\n${before}\n${lead}body\n${closer}\n`)
    assert.match(html, /<aside[^>]*>\s*<p>body<\/p>\s*<\/aside>/, before)
  }
  // Already closed: only the lead.
  assert.equal(prefixAfter('- ::: note', '\n  :::'), '  ')
})

test('list continuation leaves a colon fence on a marker line to the fence continuation', () => {
  assert.equal(listContinuationEdits('- ::: note\n\n', { line: 1, character: 0 }), null)
  assert.equal(listContinuationEdits('> ::: note\n\n', { line: 1, character: 0 }), null)
})

test('keeps a missing final line ending missing when adding it changes the render', () => {
  assert.equal(formatDocument('```\nx'), '```\nx')
  assert.equal(formatDocument('```\nx\n```'), '```\nx\n```\n')
})

test('formatting stays render-equivalent when a corpus document loses its final newline', async () => {
  const { readdirSync, readFileSync } = await import('node:fs')
  const dir = new URL('../tests/spec/tests/corpus/', import.meta.url)
  for (const name of readdirSync(dir).filter((entry) => entry.endsWith('.crv'))) {
    const source = readFileSync(new URL(name, dir), 'utf8').replace(/\r?\n$/, '')
    assert.equal(carveToHtml(formatDocument(source)), carveToHtml(source), name)
  }
})

test('an inline comment does not stop a table or quote continuation', () => {
  assert.equal(prefixAfter('| a | %% note'), '| ')
  assert.equal(prefixAfter('> a %% note'), '> ')
})

test('closedness is judged with the cursor line holding the container lead', () => {
  for (const [before, after, expected] of [
    ['> ::: note', '> x\n> :::', '> '],
    ['> > ::: note', '> > x\n> > :::', '> > '],
    ['- ::: note', '  x\n  :::', '  '],
    ['[^1]: ::: note', '  x\n  :::', '  '],
    ['::: note', 'x\n:::', ''],
  ] as const) assert.equal(prefixAfter(before, after), expected, before)
})

test('continuationEdits keeps a closer off the cursor position', () => {
  const at = (line: number, character: number) => ({ start: { line, character }, end: { line, character } })
  assert.deepEqual(continuationEdits('::: note\n\nrest', { line: 1, character: 0 }), [{ range: at(2, 0), newText: ':::\n' }])
  assert.deepEqual(continuationEdits('```js\n\n', { line: 1, character: 0 }), [{ range: at(2, 0), newText: '```\n' }])
  assert.deepEqual(continuationEdits('> ::: note\n\n', { line: 1, character: 0 }), [
    { range: at(1, 0), newText: '> ' },
    { range: at(2, 0), newText: '> :::\n' },
  ])
  // The last line has no next line, so the prefix stays one insert at the cursor.
  assert.deepEqual(continuationEdits('::: note\n', { line: 1, character: 0 }), [{ range: at(1, 0), newText: '\n:::' }])
  assert.deepEqual(continuationEdits('> ::: note\n', { line: 1, character: 0 }), [{ range: at(1, 0), newText: '> \n> :::' }])
  assert.deepEqual(continuationEdits('> q\n', { line: 1, character: 0 }), [{ range: at(1, 0), newText: '> ' }])
  assert.deepEqual(continuationEdits('plain\n', { line: 1, character: 0 }), [])
})

test('continuationEdits writes the closer with the document line ending', () => {
  const at = (line: number, character: number) => ({ start: { line, character }, end: { line, character } })
  assert.deepEqual(continuationEdits('::: note\r\n\r\nrest', { line: 1, character: 0 }), [{ range: at(2, 0), newText: ':::\r\n' }])
  assert.deepEqual(continuationEdits('> ::: note\r\n', { line: 1, character: 0 }), [{ range: at(1, 0), newText: '> \r\n> :::' }])
})
