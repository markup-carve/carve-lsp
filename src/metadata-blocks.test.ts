import assert from 'node:assert/strict'
import test from 'node:test'
import { semanticTokens } from './semantic.js'
import { scanDocument } from './workspace-index.js'

// A typed metadata block after line 1 (C2-B-232) is a `frontmatter` node, read like the leading one.
const later = '# H\n\nText.\n\n---yaml\nref: </#H> [^n]\n---\n\nMore.\n'

test('a metadata block after line 1 is colored like the leading frontmatter', () => {
  const lead = semanticTokens('---yaml\nref: </#H> [^n]\n---\n').map((token) => [token.line, token.length, token.type])
  const tokens = semanticTokens(later).filter((token) => token.line >= 4 && token.line <= 6).map((token) => [token.line - 4, token.length, token.type])
  assert.deepEqual(tokens, lead)
  assert.deepEqual(tokens.map((token) => token[2]), ['string', 'string', 'string'])
})

test('references inside a metadata block are not navigable', () => {
  assert.deepEqual(scanDocument('file:///a.crv', later).map((token) => [token.kind, token.key, token.declaration]), [['heading', 'H', true]])
})
