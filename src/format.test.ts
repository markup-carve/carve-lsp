import assert from 'node:assert/strict'
import test from 'node:test'
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

test('is idempotent', () => {
  const once = formatDocument('# T')
  assert.equal(formatDocument(once), once)
})
