import test from 'node:test'
import assert from 'node:assert/strict'
import { fileURLToPath } from 'node:url'
import { bareListMarkerHints, editedLine } from './list-marker-hints.js'
import { LspStdioClient } from './lsp-stdio-client.js'

const labels = (source: string, line: number | undefined) => bareListMarkerHints(source, line).map((hint) => hint.label)

test('hints a bare marker on the edited line inside a list', () => {
  assert.deepEqual(labels('- first\n- second\n- ', 2), ['list item'])
  assert.deepEqual(labels('1. first\n2. ', 1), ['list item'])
  assert.deepEqual(labels('a) first\nb) ', 1), ['list item'])
  assert.deepEqual(labels('. first\n. ', 1), ['list item'])
  assert.deepEqual(labels('- [x] done\n- [ ] ', 1), ['task'])
  assert.deepEqual(labels('- first\n  more\n- ', 2), ['list item'])
  assert.deepEqual(labels('- first\n\n- ', 2), ['list item'])
  assert.deepEqual(labels('- first\n  - ', 1), ['list item'])
  assert.deepEqual(labels('[^a]: - first\n  - ', 1), ['list item'])
  const [hint] = bareListMarkerHints('- first\n- ', 1)
  assert.deepEqual(hint?.position, { line: 1, character: 2 })
})

test('does not hint outside the edited line or outside a list', () => {
  assert.deepEqual(labels('- first\n- ', 0), [])
  assert.deepEqual(labels('- first\n- ', undefined), [])
  assert.deepEqual(labels('A separator\n- ', 1), [])
  assert.deepEqual(labels('- ', 0), [])
  assert.deepEqual(labels('# Title\n\n- ', 2), [])
  assert.deepEqual(labels('- first\n- second', 1), [])
  assert.deepEqual(labels('- first\n-', 1), [])
  // A tab separator and a mixed-case roman numeral never make a list item.
  assert.deepEqual(labels('- first\n-\t', 1), [])
  assert.deepEqual(labels('iii. first\niV. ', 1), [])
  assert.deepEqual(labels('iii. first\niv. ', 1), ['list item'])
  assert.deepEqual(labels('- first\n+ ', 1), [])
  assert.deepEqual(labels('- first\n(1) ', 1), [])
  assert.deepEqual(labels('1. first\n2. [ ] ', 1), [])
  assert.deepEqual(labels('::: note\n- first\n:::\n- ', 3), [])
  assert.deepEqual(labels('- first\n\n```\n- \n```\n', 3), [])
  assert.deepEqual(labels('- first\n\n  %%%\n  - \n  %%%\n', 3), [])
})

test('hints a bare marker in a list inside a container', () => {
  assert.deepEqual(labels('> - first\n> - ', 1), ['list item'])
  assert.deepEqual(labels('> - first\r> - ', 1), ['list item'])
  assert.deepEqual(labels('- first\r- ', 1), ['list item'])
  assert.deepEqual(labels('> - [x] done\n> - [ ] ', 1), ['task'])
  assert.deepEqual(labels('> > - a\n> > - ', 1), ['list item'])
  assert.deepEqual(labels('- item\n  > - a\n  > - ', 2), ['list item'])
  assert.deepEqual(labels('> ::: note\n> - a\n> - ', 2), ['list item'])
  assert.deepEqual(labels(':: term\n: - first\n  - ', 2), ['list item'])
  assert.deepEqual(labels('[^a]:   - first\n  - ', 1), ['list item'])
  const [hint] = bareListMarkerHints('> - first\n> - ', 1)
  assert.deepEqual(hint?.position, { line: 1, character: 4 })
  // A quote with no list, a comment or fence in a quote, and a tab separator stay unhinted.
  assert.deepEqual(labels('> quoted\n> - ', 1), [])
  assert.deepEqual(labels('> - first\n>-\t', 1), [])
  assert.deepEqual(labels('> - first\n>\n> %%%\n> - \n> %%%\n', 3), [])
  assert.deepEqual(labels('> - first\n>\n> ```\n> - \n> ```\n', 3), [])
  assert.deepEqual(labels('- one\n  > - ', 1), [])
})

test('honors the requested range', () => {
  const range = (start: number, end: number) => ({ start: { line: start, character: 0 }, end: { line: end, character: 0 } })
  assert.equal(bareListMarkerHints('- first\n- ', 1, range(0, 0)).length, 0)
  assert.equal(bareListMarkerHints('- first\n- ', 1, range(0, 1)).length, 1)
})

test('reads the edited line from didChange ranges', () => {
  const at = (line: number, character: number) => ({ line, character })
  assert.equal(editedLine([{ range: { start: at(3, 1), end: at(3, 1) }, text: ' ' }]), 3)
  assert.equal(editedLine([{ range: { start: at(3, 6), end: at(3, 6) }, text: '\n- ' }]), 4)
  assert.equal(editedLine([{ range: { start: at(3, 6), end: at(3, 6) }, text: '\r\n- ' }]), 4)
  assert.equal(editedLine([
    { range: { start: at(9, 0), end: at(9, 0) }, text: 'x' },
    { range: { start: at(1, 0), end: at(1, 0) }, text: '- ' },
  ]), 1)
  assert.equal(editedLine([{ text: 'whole document' }]), undefined)
  assert.equal(editedLine([]), undefined)
})

test('the server hints the line the last didChange touched', async (context) => {
  const client = LspStdioClient.spawnServer(fileURLToPath(new URL('./server.js', import.meta.url)))
  context.after(() => client.stop())
  await client.request('initialize', { processId: null, capabilities: {}, workspaceFolders: [], initializationOptions: {} })
  client.notify('initialized', {})
  const uri = 'untitled:hints.crv'
  client.notify('textDocument/didOpen', { textDocument: { uri, languageId: 'carve', version: 1, text: '- first\n\n- \n' } })
  const hints = async () => (await client.request('textDocument/inlayHint', {
    textDocument: { uri },
    range: { start: { line: 0, character: 0 }, end: { line: 4, character: 0 } },
  }) as Array<{ label: string, position: unknown }>).filter((hint) => hint.label === 'list item')
  // Opened, not edited: the bare marker on line 2 is not hinted.
  assert.deepEqual(await hints(), [])
  client.notify('textDocument/didChange', {
    textDocument: { uri, version: 2 },
    contentChanges: [{ range: { start: { line: 0, character: 7 }, end: { line: 0, character: 7 } }, text: '\n- ' }],
  })
  assert.deepEqual(await hints(), [{ label: 'list item', position: { line: 1, character: 2 }, tooltip: 'A list marker needs content after it; until then this line is paragraph text.' }])
  client.notify('textDocument/didChange', {
    textDocument: { uri, version: 3 },
    contentChanges: [{ range: { start: { line: 0, character: 7 }, end: { line: 0, character: 7 } }, text: '!' }],
  })
  assert.deepEqual(await hints(), [])
  client.notify('workspace/didChangeConfiguration', { settings: { carve: { inlayHints: { bareListMarkers: false } } } })
  client.notify('textDocument/didChange', {
    textDocument: { uri, version: 4 },
    contentChanges: [{ range: { start: { line: 1, character: 2 }, end: { line: 1, character: 2 } }, text: '' }],
  })
  assert.deepEqual(await hints(), [])
})
