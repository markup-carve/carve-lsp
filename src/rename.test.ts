import assert from 'node:assert/strict'
import test from 'node:test'
import { prepareRename, renameEdits } from './rename.js'

const URI = 'file:///doc.crv'

test('prepareRename reports the footnote label under the cursor', () => {
  const result = prepareRename('see[^a]\n\n[^a]: note', { line: 2, character: 2 })
  assert.equal(result?.placeholder, 'a')
})

test('renames every occurrence of a footnote label', () => {
  const source = 'see[^a] and[^a]\n\n[^a]: note'
  const edit = renameEdits(URI, source, { line: 2, character: 2 }, 'b')
  const edits = edit?.changes?.[URI] ?? []
  assert.equal(edits.length, 3)
  assert.ok(edits.every((e) => e.newText === 'b'))
})

test('renames link reference labels', () => {
  const source = '[site]: https://example.com\n\nsee [text][site]'
  const edit = renameEdits(URI, source, { line: 0, character: 2 }, 'home')
  assert.equal(edit?.changes?.[URI]?.length, 2)
})

test('renames link reference labels containing spaces', () => {
  const source = '[my label]: https://example.com\n\nsee [text][my label]'
  const edit = renameEdits(URI, source, { line: 0, character: 3 }, 'home')
  assert.equal(edit?.changes?.[URI]?.length, 2)
})

test('footnote and link-reference labels are separate namespaces', () => {
  const source = '[a]: https://example.com\n\n[^a]: note\n\nuse [x][a] and[^a]'
  const edit = renameEdits(URI, source, { line: 2, character: 2 }, 'b') // on the footnote def
  // Only the two footnote occurrences, not the link reference `[a]`.
  assert.equal(edit?.changes?.[URI]?.length, 2)
})

test('rejects invalid new names', () => {
  const source = 'see[^a]\n\n[^a]: note'
  assert.equal(renameEdits(URI, source, { line: 0, character: 5 }, 'bad name'), null)
})

test('returns null off any label', () => {
  assert.equal(prepareRename('plain text', { line: 0, character: 3 }), null)
})
