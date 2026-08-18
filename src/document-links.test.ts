import test from 'node:test'
import assert from 'node:assert/strict'
import { documentLinks } from './document-links.js'

test('links inline, reference-definition, and autolink destinations', () => {
  const links = documentLinks('file:///docs/a.crv', '[x](b.crv#h)\n[r]: https://example.test\n<mailto:a@example.test>\n')
  assert.deepEqual(links.map((link) => link.target), [
    'file:///docs/b.crv#h',
    'https://example.test/',
    'mailto:a@example.test',
  ])
})
