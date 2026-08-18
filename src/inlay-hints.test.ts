import test from 'node:test'
import assert from 'node:assert/strict'
import { inlayHints } from './inlay-hints.js'

test('shows generated heading ids and omits authored ids', () => {
  const generated = inlayHints('# Hello world\n')
  assert.equal(generated.length, 1)
  assert.match(String(generated[0]!.label).toLocaleLowerCase(), /hello-world/)
  assert.equal(inlayHints('{#custom}\n# Hello world\n').length, 0)
})
