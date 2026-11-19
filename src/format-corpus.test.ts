import assert from 'node:assert/strict'
import test from 'node:test'
import { render } from './engine.js'
import { formatDocument } from './format.js'
import { corpusDocuments } from './spec-corpus.js'

test('formatting preserves rendered HTML for every corpus document', () => {
  const documents = corpusDocuments()
  assert.ok(documents.length > 0, 'the formatter gate found no corpus documents')

  for (const { name, source } of documents) {
    assert.equal(render(formatDocument(source)), render(source), name)
  }
})
