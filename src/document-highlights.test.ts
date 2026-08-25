import test from 'node:test'
import assert from 'node:assert/strict'
import { DocumentHighlightKind } from 'vscode-languageserver/node.js'
import { documentHighlights } from './document-highlights.js'

test('highlights a declaration and its references', () => {
  const found = documentHighlights('file:///a.crv', '[^n]: note\n\nSee [^n].\n', { line: 2, character: 7 })
  assert.deepEqual(found.map((item) => item.kind), [DocumentHighlightKind.Write, DocumentHighlightKind.Read])
})

test('highlights a colon fence and its exact closer', () => {
  const found = documentHighlights('file:///a.crv', ':::: note\nbody\n::::\n', { line: 2, character: 2 })
  assert.deepEqual(found.map((item) => item.range.start.line), [0, 2])
})
