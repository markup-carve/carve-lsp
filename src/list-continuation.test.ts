import test from 'node:test'
import assert from 'node:assert/strict'
import { fileURLToPath } from 'node:url'
import { listContinuationEdits } from './format.js'
import { LspStdioClient } from './lsp-stdio-client.js'

// The document as the host holds it right after Enter: the cursor sits on the
// last line, after whatever indent the host added.
function enter(before: string, indent = ''): ReturnType<typeof listContinuationEdits> {
  const source = `${before}\n${indent}`
  const line = source.split('\n').length - 1
  return listContinuationEdits(source, { line, character: indent.length })
}

function inserted(before: string, indent = ''): string | null {
  const edits = enter(before, indent)
  if (!edits) return null
  assert.equal(edits.length, 1)
  return edits[0]!.newText
}

test('Enter after a list item writes the next marker', () => {
  for (const [before, next] of [
    ['- item', '- '],
    ['* item', '* '],
    ['1. item', '2. '],
    ['1) item', '2) '],
    ['a. item', 'b. '],
    ['A) item', 'B) '],
    ['i. item', 'ii. '],
    ['I. item', 'II. '],
    ['. item', '. '],
    ['- [x] item', '- [ ] '],
    ['- [-] item', '- [ ] '],
    ['- [ ] item', '- [ ] '],
    ['- [>] item', '- [ ] '],
    ['- [?] item', '- [ ] '],
    ['- [_] item', '- [ ] '],
    ['- [X] item', '- [ ] '],
    // Ordered items have no task box, so `[x]` there is text.
    ['1. [x] item', '2. '],
    ['. [x] item', '. '],
  ] as const) assert.equal(inserted(before), next, before)
})

test('the next marker follows the list, not the letter', () => {
  // A single roman letter is alpha inside an alpha list and roman inside a roman one.
  assert.equal(inserted('h. one\ni. two'), 'j. ')
  assert.equal(inserted('ix. one\nx. two'), 'xi. ')
  assert.equal(inserted('u. one\nv. two'), 'w. ')
  assert.equal(inserted('iv. one'), 'v.  ')
  assert.equal(inserted('z. last'), null)
  assert.equal(inserted('007. item'), '008. ')
  assert.equal(inserted('999999999. item'), '1000000000. ')
})

test('the content column stays put when the marker changes width', () => {
  assert.equal(inserted('-   item'), '-   ')
  assert.equal(inserted('1.  item'), '2.  ')
  assert.equal(inserted('9.  item'), '10. ')
  assert.equal(inserted('iii. item'), 'iv.  ')
  // One space is the minimum separator, so a one-space marker widens the column.
  assert.equal(inserted('9. item'), '10. ')
  assert.equal(inserted('99) item'), '100) ')
})

test('the marker keeps its indent and replaces the host indent', () => {
  const edits = enter('- a\n  - nested', '  ')
  assert.deepEqual(edits, [{
    range: { start: { line: 2, character: 0 }, end: { line: 2, character: 2 } },
    newText: '  - ',
  }])
  assert.equal(inserted('- a\n  - nested'), '  - ')
  assert.equal(inserted('::: note\n- inside'), '- ')
  assert.equal(inserted('\t- item'), '\t- ')
  assert.equal(inserted('- a\n\t- nested'), '\t- ')
  // Two markers on one line continue the outer item.
  assert.equal(inserted('- - item'), '- ')
})

test('Enter on a content-less marker removes it and ends the list', () => {
  for (const bare of ['- ', '* ', '2. ', 'b) ', 'iv. ', '. ', '- [ ] ', '*  [ ]  ']) {
    const before = `- one\n${bare}`
    const edits = enter(before)
    assert.deepEqual(edits, [{
      range: { start: { line: 1, character: 0 }, end: { line: 1, character: bare.length } },
      newText: '',
    }], JSON.stringify(bare))
  }
  // After a lazy continuation line the marker still belongs to the item.
  assert.equal(enter('- one\n  more\n- ')?.[0]?.newText, '')
})

test('lines that are not list items are not continued', () => {
  for (const before of [
    '+ text',
    '- item\n+',
    '(1) item',
    'aa. item',
    'plain prose',
    '```\n- item',
    '> - quoted',
  ]) assert.equal(enter(before), null, before)
  // A bare marker outside a list is prose, and a lone `-` without its
  // separator is never treated as a marker.
  assert.equal(enter('para\n\n- '), null)
  assert.equal(enter('- one\n-'), null)
  assert.equal(enter('```\n- one\n- '), null)
  assert.equal(enter('- one\n  ::: note\n  - '), null)
  assert.equal(enter('- one\n  > - '), null)
  // Checkbox-shaped text that is not an empty task marker is content.
  for (const text of ['- [x]', '- [x] ', '- [ ]', '1. [ ] ']) assert.notDeepEqual(enter(`- one\n${text}`)?.[0]?.newText, '', text)
  // `-<tab>` and mixed-case roman are text the parser folds into the item, not markers.
  for (const text of ['-\t', '*\t', '2.\t', '- [ ]\t', 'iV. ', 'Xi) ']) assert.notDeepEqual(enter(`- one\n${text}`)?.[0]?.newText, '', JSON.stringify(text))
})

test('a list line inside a closed fence is code', () => {
  for (const fence of ['```', '~~~', '``` =html']) {
    const close = fence.slice(0, 3)
    const source = `- item\n\n${fence}\n- code\n\n${close}\n`
    assert.equal(listContinuationEdits(source, { line: 4, character: 0 }), null, fence)
  }
})

test('nothing happens when Enter split a line', () => {
  const source = '- one\n- two\nrest'
  assert.equal(listContinuationEdits(source, { line: 2, character: 0 }), null)
})

test('on-type formatting serves list continuation through the server', async (context) => {
  const client = LspStdioClient.spawnServer(fileURLToPath(new URL('./server.js', import.meta.url)))
  context.after(() => client.stop())
  await client.request('initialize', { processId: null, capabilities: {}, workspaceFolders: [], initializationOptions: {} })
  client.notify('initialized', {})
  client.notify('textDocument/didOpen', {
    textDocument: { uri: 'untitled:list.crv', languageId: 'carve', version: 1, text: '1. one\n\n' },
  })
  const typed = async (line: number) => await client.request('textDocument/onTypeFormatting', {
    textDocument: { uri: 'untitled:list.crv' },
    position: { line, character: 0 },
    ch: '\n',
    options: { tabSize: 2, insertSpaces: true },
  })
  assert.deepEqual(await typed(1), [{ range: { start: { line: 1, character: 0 }, end: { line: 1, character: 0 } }, newText: '2. ' }])
  client.notify('textDocument/didChange', {
    textDocument: { uri: 'untitled:list.crv', version: 2 },
    contentChanges: [{ text: '1. one\n2. \n\n' }],
  })
  assert.deepEqual(await typed(2), [{ range: { start: { line: 1, character: 0 }, end: { line: 1, character: 3 } }, newText: '' }])
})
