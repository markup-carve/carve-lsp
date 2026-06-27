import assert from 'node:assert/strict'
import test from 'node:test'
import { referencesAt } from './references.js'

const URI = 'file:///doc.crv'
const withDecl: import('vscode-languageserver/node.js').ReferenceContext = { includeDeclaration: true }
const noDecl: import('vscode-languageserver/node.js').ReferenceContext = { includeDeclaration: false }

// ---------------------------------------------------------------------------
// Heading / cross-reference
// ---------------------------------------------------------------------------

test('from heading line: finds all </#id> crossrefs', () => {
  const source = '# Intro\n\nSee </#intro> and again </#intro>.'
  const locs = referencesAt(URI, source, { line: 0, character: 3 }, noDecl)
  assert.ok(locs)
  assert.equal(locs.length, 2)
  assert.ok(locs.every((l) => l.range.start.line === 2))
})

test('from heading line with includeDeclaration includes the heading', () => {
  const source = '# Intro\n\nSee </#intro>.'
  const locs = referencesAt(URI, source, { line: 0, character: 3 }, withDecl)
  assert.ok(locs)
  assert.equal(locs.length, 2) // heading + crossref
  assert.ok(locs.some((l) => l.range.start.line === 0))
  assert.ok(locs.some((l) => l.range.start.line === 2))
})

test('from crossref usage: finds all other crossrefs', () => {
  const source = '# Intro\n\n</#intro> and </#intro>.'
  const locs = referencesAt(URI, source, { line: 2, character: 3 }, noDecl)
  assert.ok(locs)
  assert.equal(locs.length, 2)
})

test('from fragment link [text](#id): finds all usages', () => {
  const source = '# Setup\n\n[link](#setup) and [other](#setup).'
  const locs = referencesAt(URI, source, { line: 2, character: 5 }, noDecl)
  assert.ok(locs)
  assert.equal(locs.length, 2)
})

test('heading with no crossrefs returns empty array (noDecl)', () => {
  const source = '# Lonely\n\nsome text.'
  const locs = referencesAt(URI, source, { line: 0, character: 3 }, noDecl)
  assert.ok(locs)
  assert.equal(locs.length, 0)
})

// ---------------------------------------------------------------------------
// Footnote
// ---------------------------------------------------------------------------

test('from footnote reference: finds all usages', () => {
  const source = 'first[^fn] and second[^fn]\n\n[^fn]: text'
  const locs = referencesAt(URI, source, { line: 0, character: 7 }, noDecl)
  assert.ok(locs)
  assert.equal(locs.length, 2)
  assert.ok(locs.every((l) => l.range.start.line === 0))
})

test('from footnote reference with includeDeclaration includes def', () => {
  const source = 'see[^fn]\n\n[^fn]: note'
  const locs = referencesAt(URI, source, { line: 0, character: 5 }, withDecl)
  assert.ok(locs)
  assert.equal(locs.length, 2)
  assert.ok(locs.some((l) => l.range.start.line === 2))
})

test('from footnote definition line: finds all usages', () => {
  const source = 'see[^fn]\n\n[^fn]: note'
  const locs = referencesAt(URI, source, { line: 2, character: 3 }, noDecl)
  assert.ok(locs)
  // noDecl: only usages on line 0
  assert.equal(locs.length, 1)
  assert.equal(locs[0]!.range.start.line, 0)
})

test('footnote with no usages returns empty array (noDecl)', () => {
  const source = '[^fn]: an unused footnote'
  const locs = referencesAt(URI, source, { line: 0, character: 3 }, noDecl)
  assert.ok(locs)
  assert.equal(locs.length, 0)
})

// ---------------------------------------------------------------------------
// Citation
// ---------------------------------------------------------------------------

test('from citation usage: finds all usages', () => {
  const source = '[@smith2024]: citation\n\nsee [@smith2024] and [@smith2024].'
  const locs = referencesAt(URI, source, { line: 2, character: 8 }, noDecl)
  assert.ok(locs)
  assert.equal(locs.length, 2)
  assert.ok(locs.every((l) => l.range.start.line === 2))
})

test('from citation definition: finds all usages with includeDeclaration', () => {
  const source = '[@key]: ref\n\n[@key] is cited here.'
  const locs = referencesAt(URI, source, { line: 0, character: 3 }, withDecl)
  assert.ok(locs)
  assert.equal(locs.length, 2)
  assert.ok(locs.some((l) => l.range.start.line === 0))
})

test('citation with no usages returns empty array (noDecl)', () => {
  const source = '[@key]: a reference\n\nno citations here.'
  const locs = referencesAt(URI, source, { line: 0, character: 3 }, noDecl)
  assert.ok(locs)
  assert.equal(locs.length, 0)
})

// ---------------------------------------------------------------------------
// Link reference
// ---------------------------------------------------------------------------

test('from link-ref definition: finds all usages', () => {
  const source = '[carve]: https://example.com\n\n[site][carve] and [text][carve]'
  const locs = referencesAt(URI, source, { line: 0, character: 3 }, noDecl)
  assert.ok(locs)
  assert.equal(locs.length, 2)
  assert.ok(locs.every((l) => l.range.start.line === 2))
})

test('from link-ref definition with includeDeclaration includes def', () => {
  const source = '[carve]: https://example.com\n\n[site][carve]'
  const locs = referencesAt(URI, source, { line: 0, character: 3 }, withDecl)
  assert.ok(locs)
  assert.equal(locs.length, 2)
  assert.ok(locs.some((l) => l.range.start.line === 0))
})

test('from link-ref usage: finds all usages', () => {
  const source = '[ref]: https://example.com\n\n[a][ref] and [b][ref]'
  const locs = referencesAt(URI, source, { line: 2, character: 5 }, noDecl)
  assert.ok(locs)
  assert.equal(locs.length, 2)
})

test('collapsed [ref][] usage is found', () => {
  const source = '[ref]: https://example.com\n\n[ref][] and [ref][]'
  const locs = referencesAt(URI, source, { line: 0, character: 3 }, noDecl)
  assert.ok(locs)
  assert.equal(locs.length, 2)
})

test('link-ref with no usages returns empty array (noDecl)', () => {
  const source = '[ref]: https://example.com\n\nno refs here.'
  const locs = referencesAt(URI, source, { line: 0, character: 3 }, noDecl)
  assert.ok(locs)
  assert.equal(locs.length, 0)
})

// ---------------------------------------------------------------------------
// Wikilink
// ---------------------------------------------------------------------------

test('wikilink [[Page]]: finds all usages (case-insensitive)', () => {
  const source = '# Tigers\n\nSee [[Tigers]] and [[tigers]].'
  const locs = referencesAt(URI, source, { line: 2, character: 6 }, noDecl)
  assert.ok(locs)
  assert.equal(locs.length, 2)
})

test('wikilink with includeDeclaration includes heading', () => {
  const source = '# Tigers\n\nSee [[Tigers]].'
  const locs = referencesAt(URI, source, { line: 2, character: 6 }, withDecl)
  assert.ok(locs)
  assert.equal(locs.length, 2)
  assert.ok(locs.some((l) => l.range.start.line === 0))
})

// ---------------------------------------------------------------------------
// No-op cases
// ---------------------------------------------------------------------------

test('returns null on plain text with no navigable construct', () => {
  const locs = referencesAt(URI, 'just some text', { line: 0, character: 5 }, noDecl)
  assert.equal(locs, null)
})

test('returns null on empty line', () => {
  const locs = referencesAt(URI, 'line one\n\nline three', { line: 1, character: 0 }, noDecl)
  assert.equal(locs, null)
})
