import assert from 'node:assert/strict'
import test from 'node:test'
import { codepointColumnToUtf16, sourceLines, utf16CharToCodepointColumn } from './position.js'

// An emoji is two UTF-16 code units and one codepoint, so every column after it
// differs between the two units. Everything below that line is BMP-only, where
// the two agree and the conversion has to stay the identity.

test('a BMP-only line converts as the identity', () => {
  const line = 'a *b* c'
  for (let column = 1; column <= line.length + 1; column++) {
    assert.equal(codepointColumnToUtf16(line, column), column - 1)
  }
  for (let character = 0; character <= line.length; character++) {
    assert.equal(utf16CharToCodepointColumn(line, character), character + 1)
  }
})

test('an astral character shifts every column after it', () => {
  // The `*` sits at codepoint column 3 and UTF-16 character 3, because the
  // emoji occupies one codepoint and two code units.
  const line = '\u{1F600} *b*'
  assert.equal(line.indexOf('*'), 3)

  assert.equal(codepointColumnToUtf16(line, 1), 0)
  assert.equal(codepointColumnToUtf16(line, 2), 2)
  assert.equal(codepointColumnToUtf16(line, 3), 3)
  assert.equal(codepointColumnToUtf16(line, 6), 6)

  assert.equal(utf16CharToCodepointColumn(line, 0), 1)
  assert.equal(utf16CharToCodepointColumn(line, 2), 2)
  assert.equal(utf16CharToCodepointColumn(line, 3), 3)
  assert.equal(utf16CharToCodepointColumn(line, 6), 6)
})

test('the two conversions round-trip through each other', () => {
  const line = 'x\u{1F600}y\u{1F1E9}\u{1F1EA}z'
  for (let column = 1; column <= 7; column++) {
    assert.equal(utf16CharToCodepointColumn(line, codepointColumnToUtf16(line, column)), column)
  }
})

test('an exclusive end column lands on the end of the line', () => {
  const line = '\u{1F600}ab'
  // Three codepoints, so the exclusive end column is 4 and the UTF-16 end is
  // the string's length.
  assert.equal(codepointColumnToUtf16(line, 4), line.length)
  assert.equal(codepointColumnToUtf16(line, 4), 4)
})

test('a column past the end keeps its distance rather than collapsing', () => {
  // Ranges are built from two converted columns; clamping both to the end
  // would silently produce an empty range where the parser reported a span.
  const line = 'ab'
  assert.equal(codepointColumnToUtf16(line, 5), 4)
  assert.equal(utf16CharToCodepointColumn(line, 5), 6)
})

test('a character inside a surrogate pair resolves past it', () => {
  const line = '\u{1F600}a'
  assert.equal(utf16CharToCodepointColumn(line, 1), 2)
})

test('an empty line converts without moving', () => {
  assert.equal(codepointColumnToUtf16('', 1), 0)
  assert.equal(utf16CharToCodepointColumn('', 0), 1)
})

test('lines are split on every line ending form', () => {
  assert.deepEqual(sourceLines('a\r\nb\rc\nd'), ['a', 'b', 'c', 'd'])
})
