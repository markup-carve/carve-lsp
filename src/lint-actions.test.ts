import test from 'node:test'
import assert from 'node:assert/strict'
import { lintCodeActions } from './lint-actions.js'

const diagnostic = (code: string) => ({
  code,
  message: code,
  range: { start: { line: 0, character: 0 }, end: { line: 0, character: 1 } },
})

test('offers safe lint quick fixes', () => {
  const raw = lintCodeActions('file:///a.crv', '```raw html\n', [diagnostic('raw-block-syntax')])
  assert.equal(raw[0]?.edit?.changes?.['file:///a.crv']?.[0]?.newText, '```=html')
  const quote = lintCodeActions('file:///a.crv', '>text\n', [diagnostic('blockquote-marker-without-space')])
  assert.equal(quote[0]?.edit?.changes?.['file:///a.crv']?.[0]?.newText, ' ')
})

test('creates missing footnote and link-reference definitions', () => {
  const footnote = lintCodeActions('file:///a.crv', 'See [^n].\n', [diagnostic('unresolved-footnote')])
  assert.match(footnote[0]?.edit?.changes?.['file:///a.crv']?.[0]?.newText ?? '', /\[\^n\]:/)
  const link = lintCodeActions('file:///a.crv', 'See [x][r].\n', [diagnostic('unresolved-reference-link')])
  assert.match(link[0]?.edit?.changes?.['file:///a.crv']?.[0]?.newText ?? '', /\[r\]:/)
})

test('offers both explicit intentions for a near colon closer', () => {
  const near = { ...diagnostic('colon-fence-length-mismatch'), data: { expectedWidth: 4 } }
  const actions = lintCodeActions('file:///a.crv', ':::\n', [near])
  assert.deepEqual(actions.map((action) => action.title), [
    'Resize to 4 colons and close the container',
    'Preserve the colon run as literal text',
  ])
  assert.equal(actions[0]?.edit?.changes?.['file:///a.crv']?.[0]?.newText, '::::')
  assert.equal(actions[1]?.edit?.changes?.['file:///a.crv']?.[0]?.newText, '\\')
})
