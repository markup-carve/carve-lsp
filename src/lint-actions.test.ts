import test from 'node:test'
import assert from 'node:assert/strict'
import { render } from './engine.js'
import { analyzeCarve } from './analyze.js'
import { lintCodeActions } from './lint-actions.js'

const diagnostic = (code: string) => ({
  code,
  message: code,
  range: { start: { line: 0, character: 0 }, end: { line: 0, character: 1 } },
})

test('offers safe lint quick fixes', () => {
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

test('pads the marker run the diagnostic points at', () => {
  const source = '| x |{.a}<c |{.b}>d |\n'
  const edits = [at('table-marker-run-padding', 0, 5, 10), at('table-marker-run-padding', 0, 13, 18)]
    .map((item) => lintCodeActions('file:///a.crv', source, [item])[0]?.edit?.changes?.['file:///a.crv']?.[0]?.range.start.character)
  assert.deepEqual(edits, [9, 17])
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

test('offers no escape for a removed + continuation marker, which is text in 0.2', () => {
  for (const source of ['[^n]: a\n+\n', '- a\n+\n- b\n']) {
    assert.ok(analyzeCarve(source).diagnostics.some((d) => d.code === 'deprecated-continuation-marker'), source)
    assert.equal(applyFirst(source, 'Escape the +'), undefined, source)
  }
})

test('rewrites a deprecated alignment prefix in the braced spelling (carve#5091 D3)', () => {
  for (const [source, expected] of [
    ['|=> Price |= Name |\n| 1 | a |\n', '|={>} Price |= Name |\n| 1 | a |\n'],
    ['|= Price |= Name |\n| 1 |> a |\n', '|= Price |= Name |\n| 1 |{>} a |\n'],
    ['> |=<v Top |\n', '> |={<v} Top |\n'],
  ] as const) {
    const fixed = applyFirst(source, 'Write the alignment')
    assert.equal(fixed, expected, source)
    // In 0.2 the old prefix is cell text, so the rewrite is what restores the alignment.
    assert.match(render(fixed!), /text-align/, source)
    assert.deepEqual(analyzeCarve(fixed!).diagnostics.filter((d) => d.code === 'deprecated-cell-alignment'), [], source)
  }
})

test('terminates any table cell marker run the engine reports', () => {
  for (const [source, expected] of [
    ['| a |{.a}>x |\n', '| a |{.a} >x |\n'],
    ['| a |{.b}<x |\n', '| a |{.b} <x |\n'],
  ] as const) assert.equal(applyFirst(source, 'Terminate'), expected, source)
})

test('moves a list marker below the content column to either column the engine names', () => {
  // 0.2 reports a marker between two open lists, so each case has a nested list above it.
  assert.equal(applyFirst('- a\n  - b\n - c\n', 'Indent'), '- a\n  - b\n  - c\n')
  assert.equal(applyFirst('- a\n  - b\n - c\n', 'Outdent'), '- a\n  - b\n- c\n')
  assert.equal(applyFirst('> - a\n>   - b\n>  - c\n', 'Indent'), '> - a\n>   - b\n>   - c\n')
  assert.equal(applyFirst('> - a\n>   - b\n>  - c\n', 'Outdent'), '> - a\n>   - b\n> - c\n')
  for (const fixed of ['- a\n  - b\n  - c\n', '- a\n  - b\n- c\n', '> - a\n>   - b\n>   - c\n', '> - a\n>   - b\n> - c\n']) {
    assert.deepEqual(analyzeCarve(fixed).diagnostics.filter((d) => d.code === 'list-marker-below-content-column'), [], fixed)
  }
})

test('indents a description separator below its list to the column the engine names', () => {
  // A term under list text needs a blank line in 0.2 (U-009).
  assert.equal(applyFirst('- a\n\n  :: term\n : detail\n', 'Indent'), '- a\n\n  :: term\n  : detail\n')
  assert.equal(applyFirst('- a\n\n  :: term\n: detail\n', 'Indent'), '- a\n\n  :: term\n  : detail\n')
  assert.deepEqual(analyzeCarve('- a\n\n  :: term\n  : detail\n').diagnostics.filter((d) => d.code === 'description-separator-below-content-column'), [])
})

test('replaces a near-miss consumed key with the key the engine suggests', () => {
  const csv = '```csv\na,b\n1,2\n```\n'
  assert.equal(applyFirst(`{tabel}\n${csv}`, 'Change'), `{table}\n${csv}`)
  assert.equal(applyFirst(`{#t tables .wide}\n${csv}`, 'Change'), `{#t table .wide}\n${csv}`)
  assert.equal(applyFirst(`{tabel title="a tabel b"}\n${csv}`, 'Change'), `{table title="a tabel b"}\n${csv}`)
  assert.deepEqual(analyzeCarve(`{table}\n${csv}`).diagnostics.filter((d) => d.code === 'consumed-key-near-miss'), [])
})
