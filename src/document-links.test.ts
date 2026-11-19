import test from 'node:test'
import assert from 'node:assert/strict'
import { documentLinks } from './document-links.js'

test('links inline, reference-definition, and autolink destinations', () => {
  // 0.2 U-005: a definition directly under text is text, so blank lines separate the blocks.
  const links = documentLinks('file:///docs/a.crv', '[x](b.crv#h)\n\n[r]: https://example.test\n\n<mailto:a@example.test>\n')
  assert.deepEqual(links.map((link) => link.target), [
    'file:///docs/b.crv#h',
    'https://example.test/',
    'mailto:a@example.test',
  ])
})
