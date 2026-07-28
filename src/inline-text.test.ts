import assert from 'node:assert/strict'
import test from 'node:test'
import { smartPunctuationText } from './inline-text.js'

// The nodes below are written literally rather than produced by parse(), so the
// tests hold whether or not the installed @markup-carve/carve emits
// smart_punctuation yet. That is the point: the regression this guards against
// arrives with a dependency bump, and a test that only exercises the current
// dependency would pass right up until the day it mattered.

test('a quote node contributes its resolved glyph', () => {
  // Quote glyphs are locale-dependent and fixed during parsing, so the node
  // carries the character rather than leaving it to a kind lookup.
  assert.equal(
    smartPunctuationText({ type: 'smart_punctuation', kind: 'right_single_quote', value: "'", glyph: '’' }),
    '’',
  )
})

test('a node without a glyph falls back to the author source run', () => {
  assert.equal(
    smartPunctuationText({ type: 'smart_punctuation', kind: 'ellipsis', value: '...' }),
    '...',
  )
  assert.equal(
    smartPunctuationText({ type: 'smart_punctuation', kind: 'em_dash', value: '---' }),
    '---',
  )
})

test('other node types contribute nothing', () => {
  // The helper sits in a final else, so every unrecognized node reaches it. It
  // must stay silent for anything that is not smart punctuation, matching the
  // previous behavior of those chains.
  assert.equal(smartPunctuationText({ type: 'soft_break' }), '')
  assert.equal(smartPunctuationText({ type: 'text', value: 'x' }), '')
})

test('malformed input does not throw', () => {
  assert.equal(smartPunctuationText(null), '')
  assert.equal(smartPunctuationText(undefined), '')
  assert.equal(smartPunctuationText('not a node'), '')
  assert.equal(smartPunctuationText({ type: 'smart_punctuation' }), '')
  assert.equal(smartPunctuationText({ type: 'smart_punctuation', value: 42 }), '')
})
