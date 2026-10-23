import test from 'node:test'
import assert from 'node:assert/strict'
import { carveToHtml } from '@markup-carve/carve'
import { analyzeCarve } from './analyze.js'
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

const at = (code: string, line: number, start: number, end: number) => ({
  code, message: code, range: { start: { line, character: start }, end: { line, character: end } },
})

test('pads the alignment run the diagnostic points at', () => {
  const source = '| x |<c |>d |\n'
  const edits = [at('table-alignment-run-padding', 0, 5, 6), at('table-alignment-run-padding', 0, 9, 10)]
    .map((item) => lintCodeActions('file:///a.crv', source, [item])[0]?.edit?.changes?.['file:///a.crv']?.[0]?.range.start.character)
  assert.deepEqual(edits, [6, 10])
})

test('a created definition is separated from a trailing paragraph', () => {
  const newText = (source: string, code: string) => lintCodeActions('file:///a.crv', source, [diagnostic(code)])[0]?.edit?.changes?.['file:///a.crv']?.[0]?.newText
  assert.equal(newText('Some text[^x]', 'unresolved-footnote'), '\n\n[^x]: ')
  assert.equal(newText('Some text[^x]\n', 'unresolved-footnote'), '\n[^x]: ')
  assert.equal(newText('Some text[^x]\n\n', 'unresolved-footnote'), '[^x]: ')
  assert.equal(newText('See [x][r]', 'unresolved-reference-link'), '\n\n[r]: ')
  assert.equal(newText('Some text[^x]\r\n', 'unresolved-footnote'), '\r\n[^x]: ')
})

function applyFirst(source: string, title?: string): string | undefined {
  const diagnostics = analyzeCarve(source).diagnostics
  const actions = lintCodeActions('file:///a.crv', source, diagnostics)
  const action = title ? actions.find((candidate) => candidate.title.startsWith(title)) : actions[0]
  const edit = action?.edit?.changes?.['file:///a.crv']?.[0]
  if (!edit) return undefined
  const lines = source.split('\n')
  const line = lines[edit.range.start.line]!
  lines[edit.range.start.line] = line.slice(0, edit.range.start.character) + edit.newText + line.slice(edit.range.end.character)
  return lines.join('\n')
}

test('escapes a refused continuation marker without changing the output', () => {
  for (const source of ['q\n+\n- s\n', '- a\n+\n\n- b\n', '> q\n>   +\n']) {
    const fixed = applyFirst(source, 'Escape the +')
    assert.ok(fixed, source)
    assert.equal(carveToHtml(fixed), carveToHtml(source))
    assert.deepEqual(analyzeCarve(fixed).diagnostics.filter((d) => d.code === 'continuation-marker-refused'), [])
  }
})

test('moves a list marker below the content column to either column the engine names', () => {
  assert.equal(applyFirst('- a\n\n - b\n', 'Indent'), '- a\n\n  - b\n')
  assert.equal(applyFirst('- a\n\n - b\n', 'Outdent'), '- a\n\n- b\n')
  assert.equal(applyFirst('> - a\n>\n>  - b\n', 'Indent'), '> - a\n>\n>   - b\n')
  assert.equal(applyFirst('> - a\n>\n>  - b\n', 'Outdent'), '> - a\n>\n> - b\n')
  assert.equal(applyFirst('10. a\n\n  - b\n', 'Indent'), '10. a\n\n    - b\n')
  for (const fixed of ['- a\n\n  - b\n', '- a\n\n- b\n', '> - a\n>\n>   - b\n', '> - a\n>\n> - b\n']) {
    assert.deepEqual(analyzeCarve(fixed).diagnostics.filter((d) => d.code === 'list-marker-below-content-column'), [], fixed)
  }
})

test('indents a description separator below its list to the column the engine names', () => {
  assert.equal(applyFirst('- a\n  :: term\n : detail\n', 'Indent'), '- a\n  :: term\n  : detail\n')
  assert.equal(applyFirst('- a\n  :: term\n: detail\n', 'Indent'), '- a\n  :: term\n  : detail\n')
  assert.deepEqual(analyzeCarve('- a\n  :: term\n  : detail\n').diagnostics.filter((d) => d.code === 'description-separator-below-content-column'), [])
})

test('replaces a near-miss consumed key with the key the engine suggests', () => {
  const csv = '```csv\na,b\n1,2\n```\n'
  assert.equal(applyFirst(`{tabel}\n${csv}`, 'Change'), `{table}\n${csv}`)
  assert.equal(applyFirst(`{#t tables .wide}\n${csv}`, 'Change'), `{#t table .wide}\n${csv}`)
  assert.equal(applyFirst(`{tabel title="a tabel b"}\n${csv}`, 'Change'), `{table title="a tabel b"}\n${csv}`)
  assert.deepEqual(analyzeCarve(`{table}\n${csv}`).diagnostics.filter((d) => d.code === 'consumed-key-near-miss'), [])
})
