import assert from 'node:assert/strict'
import test from 'node:test'
import { render } from './engine.js'
import { formatDocument } from './format.js'
import { specDocuments } from './spec-examples.js'

test('formatting preserves rendered HTML for every spec example', () => {
  const documents = specDocuments()
  assert.ok(documents.length > 0, 'the formatter gate found no spec examples')

  for (const { name, source } of documents) {
    assert.equal(render(formatDocument(source)), render(source), name)
  }
})
