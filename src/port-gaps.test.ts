import test from 'node:test'
import assert from 'node:assert/strict'
import { analyzeCarve } from './analyze.js'
import { previewMarkdown, WriterNotAvailableError } from './preview.js'

// Features the 0.2 engine cannot serve yet. Each skip names the engine issue that brings it back.

test('Markdown export fails with a clear error until the markdown writer is registered', () => {
  assert.throws(() => previewMarkdown('# Title\n'), (error: unknown) =>
    error instanceof WriterNotAvailableError && /markdown writer is not available yet in Carve 0\.2/.test(error.message))
})

test('Markdown export writes Markdown through the writer registry', { skip: 'carve-js v2 registers no markdown writer yet (markup-carve/carve-js#5057)' }, () => {
  assert.match(previewMarkdown('# Title\n\n/em/ and *strong*\n'), /^# Title/)
})

test('the semantic-span lint extension covers samp, var, cite and dfn', { skip: 'a v2 lint extension cannot add semantic span keys (markup-carve/carve-js#5060)' }, () => {
  const codes = analyzeCarve('{samp}\nOutput text.\n', { lint: { extensions: ['semantic-span'] } }).diagnostics.map((d) => d.code)
  assert.ok(codes.includes('semantic-attribute-outside-span'))
})
