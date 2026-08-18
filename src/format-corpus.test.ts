import assert from 'node:assert/strict'
import { readdirSync, readFileSync } from 'node:fs'
import test from 'node:test'
import { fileURLToPath } from 'node:url'
import { carveToHtml } from '@markup-carve/carve'
import { formatDocument } from './format.js'

const corpusDir = fileURLToPath(new URL('../tests/spec/tests/corpus/', import.meta.url))

test('formatting preserves rendered HTML for every corpus document', () => {
  const documents = readdirSync(corpusDir).filter((name) => name.endsWith('.crv')).sort()
  assert.ok(documents.length > 0, 'the formatter gate found no corpus documents')

  for (const name of documents) {
    const source = readFileSync(`${corpusDir}/${name}`, 'utf8')
    assert.equal(carveToHtml(formatDocument(source)), carveToHtml(source), name)
  }
})
