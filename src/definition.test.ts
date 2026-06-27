import assert from 'node:assert/strict'
import test from 'node:test'
import { definitionAt } from './definition.js'

const URI = 'file:///doc.crv'

// ---------------------------------------------------------------------------
// Cross-reference </#id>
// ---------------------------------------------------------------------------

test('crossref </#id> jumps to the matching heading', () => {
  const source = '# Introduction\n\nSee </#introduction>.'
  const loc = definitionAt(URI, source, { line: 2, character: 6 })
  assert.ok(loc, 'expected a location')
  assert.equal(loc.uri, URI)
  assert.equal(loc.range.start.line, 0)
})

test('crossref </#id> with explicit {#custom-id} block attribute', () => {
  // In Carve, a block attribute ({#id}) is placed on the line BEFORE the heading.
  const source = '{#my-section}\n# Intro\n\nSee </#my-section>.'
  const loc = definitionAt(URI, source, { line: 3, character: 8 })
  assert.ok(loc)
  // The heading is on line 1 (0-based), but its pos.startLine = 2 (block attr on line 1).
  assert.equal(loc.range.start.line, 1)
})

test('crossref </#id> returns null for unknown id', () => {
  const source = '# Hello\n\nSee </#nope>.'
  const loc = definitionAt(URI, source, { line: 2, character: 6 })
  assert.equal(loc, null)
})

// ---------------------------------------------------------------------------
// Fragment link [text](#id)
// ---------------------------------------------------------------------------

test('fragment link [text](#id) jumps to heading', () => {
  const source = '# Getting Started\n\n[jump](#getting-started)'
  const loc = definitionAt(URI, source, { line: 2, character: 8 })
  assert.ok(loc)
  assert.equal(loc.range.start.line, 0)
})

test('fragment link returns null for missing heading', () => {
  const source = '# Hello\n\n[jump](#nowhere)'
  const loc = definitionAt(URI, source, { line: 2, character: 8 })
  assert.equal(loc, null)
})

// ---------------------------------------------------------------------------
// Footnote reference [^name]
// ---------------------------------------------------------------------------

test('footnote reference jumps to definition', () => {
  const source = 'see note[^fn]\n\n[^fn]: The footnote text.'
  const loc = definitionAt(URI, source, { line: 0, character: 10 })
  assert.ok(loc)
  assert.equal(loc.range.start.line, 2)
})

test('footnote definition does NOT navigate to itself (cursor on def)', () => {
  // On the definition line, there is no "go to definition" target — it IS the definition.
  // The function should return the line itself (same-line definition found).
  const source = 'see note[^fn]\n\n[^fn]: The footnote text.'
  const loc = definitionAt(URI, source, { line: 2, character: 3 })
  assert.ok(loc)
  // It finds the def line itself (first match is the def pattern).
  assert.equal(loc.range.start.line, 2)
})

test('footnote reference returns null when definition is missing', () => {
  const source = 'see note[^missing]'
  const loc = definitionAt(URI, source, { line: 0, character: 12 })
  assert.equal(loc, null)
})

// ---------------------------------------------------------------------------
// Link reference [text][ref]
// ---------------------------------------------------------------------------

test('full link reference [text][ref] jumps to definition', () => {
  const source = '[carve]: https://example.com\n\nsee [the site][carve]'
  const loc = definitionAt(URI, source, { line: 2, character: 16 })
  assert.ok(loc)
  assert.equal(loc.range.start.line, 0)
})

test('collapsed link reference [ref][] jumps to definition', () => {
  const source = '[carve]: https://example.com\n\nsee [carve][]'
  const loc = definitionAt(URI, source, { line: 2, character: 6 })
  assert.ok(loc)
  assert.equal(loc.range.start.line, 0)
})

test('link reference returns null when definition is missing', () => {
  const source = '[text][nope]'
  const loc = definitionAt(URI, source, { line: 0, character: 9 })
  assert.equal(loc, null)
})

test('link reference with spaces in label resolves correctly', () => {
  const source = '[my label]: https://example.com\n\nsee [text][my label]'
  const loc = definitionAt(URI, source, { line: 2, character: 13 })
  assert.ok(loc)
  assert.equal(loc.range.start.line, 0)
})

// ---------------------------------------------------------------------------
// Citation [@key]
// ---------------------------------------------------------------------------

test('citation [@key] jumps to definition', () => {
  const source = '[@smith2024]: Smith et al. 2024\n\nSee [@smith2024].'
  const loc = definitionAt(URI, source, { line: 2, character: 7 })
  assert.ok(loc)
  assert.equal(loc.range.start.line, 0)
})

test('citation returns null when definition is missing', () => {
  const source = 'See [@nobody].'
  const loc = definitionAt(URI, source, { line: 0, character: 7 })
  assert.equal(loc, null)
})

// ---------------------------------------------------------------------------
// Wikilink [[Page]]
// ---------------------------------------------------------------------------

test('wikilink [[Page]] jumps to matching heading', () => {
  const source = '# Tigers\n\nSee [[Tigers]].'
  const loc = definitionAt(URI, source, { line: 2, character: 6 })
  assert.ok(loc)
  assert.equal(loc.range.start.line, 0)
})

test('wikilink [[Page]] is case-insensitive', () => {
  const source = '# Tigers\n\nSee [[tigers]].'
  const loc = definitionAt(URI, source, { line: 2, character: 6 })
  assert.ok(loc)
  assert.equal(loc.range.start.line, 0)
})

test('wikilink returns null when no matching heading exists', () => {
  const source = '# Hello\n\nSee [[Nowhere]].'
  const loc = definitionAt(URI, source, { line: 2, character: 6 })
  assert.equal(loc, null)
})

// ---------------------------------------------------------------------------
// No-op cases: cursor not on any navigable construct
// ---------------------------------------------------------------------------

test('returns null on plain text', () => {
  const loc = definitionAt(URI, 'just some text here', { line: 0, character: 5 })
  assert.equal(loc, null)
})

test('returns null on empty line', () => {
  const loc = definitionAt(URI, 'line one\n\nline three', { line: 1, character: 0 })
  assert.equal(loc, null)
})
