import test from 'node:test'
import assert from 'node:assert/strict'
import { fileURLToPath } from 'node:url'
import { carveToHtml } from '@markup-carve/carve'
import { BARE_CONTINUATION_MARKER, listContinuationEdits } from './format.js'
import { listDelim } from './list-items.js'
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

test('a list inside a container continues after the container prefix', () => {
  for (const [before, next] of [
    ['> - first', '> - '],
    ['> 1. first', '> 2. '],
    ['> - [x] done', '> - [ ] '],
    ['> - a\n>   - nested', '>   - '],
    ['> > - a', '> > - '],
    ['- item\n  > - a', '  > - '],
    ['- a\n\n  > - b', '  > - '],
    ['> ::: note\n> - a', '> - '],
    // A footnote body continues at the two-space body indent, whatever the label's width.
    ['[^a]: - first', '  - '],
    ['[^long]:   - first', '  - '],
    ['[^😀]: - first', '  - '],
    ['[^a]: - first\n  - second', '  - '],
    ['[^a]: 1. first', '  2. '],
    ['> [^a]: - first', '>   - '],
    // A description body continues at its content column.
    [':: term\n: - first', '  - '],
    [':: term\n:   1. first', '    2. '],
  ] as const) assert.equal(inserted(before), next, before)
})

test('the container prefix and the marker are one edit', () => {
  assert.deepEqual(enter('> - first', '  '), [{
    range: { start: { line: 1, character: 0 }, end: { line: 1, character: 2 } },
    newText: '> - ',
  }])
})

test('Enter on a content-less marker in a container ends the list and keeps the container', () => {
  // The marker line becomes a blank quote line, which ends the list, and the
  // cursor line is quoted so the next paragraph stays in the quote.
  for (const [before, kept, cursor] of [
    ['> - a\n> - ', '>', '> '],
    ['> > - a\n> > - ', '> >', '> > '],
    ['- item\n  > - a\n  > - ', '  >', '  > '],
    ['> ::: note\n> - a\n> - ', '>', '> '],
  ] as const) {
    const markerLine = before.split('\n').length - 1
    const marker = before.split('\n')[markerLine]!
    assert.deepEqual(enter(before), [
      { range: { start: { line: markerLine, character: 0 }, end: { line: markerLine, character: marker.length } }, newText: kept },
      { range: { start: { line: markerLine + 1, character: 0 }, end: { line: markerLine + 1, character: 0 } }, newText: cursor },
    ], before)
  }
  // An indented body (footnote, description, div) needs no prefix: the marker goes and the host indent stays.
  for (const before of ['[^a]: - first\n  - ', ':: term\n: - first\n  - ', '::: note\n- a\n- ']) {
    const markerLine = before.split('\n').length - 1
    assert.deepEqual(enter(before), [{
      range: { start: { line: markerLine, character: 0 }, end: { line: markerLine, character: before.split('\n')[markerLine]!.length } },
      newText: '',
    }], before)
  }
})

test('a list in a container inside a comment or fence is not continued', () => {
  assert.equal(listContinuationEdits('> %%%\n> - a\n> %%%\n', { line: 2, character: 0 }), null)
  assert.equal(listContinuationEdits('> - a\n>\n> ```\n> - b\n> ```\n', { line: 4, character: 0 }), null)
  assert.equal(listContinuationEdits('[^a]: text\n\n  %%%\n  - a\n  %%%\n\nx[^a]\n', { line: 4, character: 0 }), null)
  assert.equal(listContinuationEdits('[^a]: - first\n\n  ```\n  - code\n\n  ```\n', { line: 4, character: 0 }), null)
  // Text after a quoted list item is lazy text, not an item, so the quote continuation takes over.
  assert.equal(enter('> - a\n> b'), null)
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
  client.notify('textDocument/didChange', {
    textDocument: { uri: 'untitled:list.crv', version: 3 },
    contentChanges: [{ text: '> - one\n\n' }],
  })
  assert.deepEqual(await typed(1), [{ range: { start: { line: 1, character: 0 }, end: { line: 1, character: 0 } }, newText: '> - ' }])
})

test('an ordered list without a delim on its node reads as `.`', () => {
  assert.equal(listDelim({ ordered: true }), '.')
  assert.equal(listDelim({ ordered: true, delim: ')' }), ')')
  assert.equal(listDelim({ ordered: false }), undefined)
})

function applied(before: string): string {
  const source = `${before}\n`
  const edits = enter(before) ?? []
  const lines = source.split('\n')
  for (const edit of [...edits].reverse()) {
    const { start, end } = edit.range
    const head = lines[start.line]!.slice(0, start.character)
    const tail = lines[end.line]!.slice(end.character)
    lines.splice(start.line, end.line - start.line + 1, ...(head + edit.newText + tail).split('\n'))
  }
  return lines.join('\n')
}

test('an item with attributes continues with a plain marker', () => {
  for (const [before, next] of [
    ['-{.c} a', '- '],
    ['*{#x .c} a', '* '],
    ['1.{.c} a', '2. '],
    ['a){.c} a', 'b) '],
    ['-{.c} [x] a', '- [ ] '],
    ['> -{.c} a', '> - '],
    ['- a\n-{.c} b', '- '],
  ] as const) assert.equal(inserted(before), next, before)
  // The plain marker joins the attributed item's list.
  assert.equal(carveToHtml(`${applied('1.{.c} a')}b\n`), '<ol>\n  <li class="c">a</li>\n  <li>b</li>\n</ol>')
})

test('a description term or definition continues with a definition marker', () => {
  for (const [before, next] of [
    [':: term', ': '],
    [':: t\n: def', ': '],
    [':: t\n:   def', ':   '],
    [':: t\n: a\n: b', ': '],
    [':: t\n:: u', ': '],
    ['> :: t', '> : '],
    ['> :: t\n> : d', '> : '],
    ['- a\n\n  :: t\n  : d', '  : '],
  ] as const) assert.equal(inserted(before), next, before)
  for (const before of [':: term', ':: t\n: def', '> :: t\n> : d']) {
    const html = carveToHtml(`${applied(before)}more\n`)
    assert.match(html, /<dd>more<\/dd>/, before)
  }
})

test('Enter on a content-less definition marker removes it and ends the list', () => {
  assert.deepEqual(enter(':: t\n: d\n: '), [{ range: { start: { line: 2, character: 0 }, end: { line: 2, character: 2 } }, newText: '' }])
  assert.deepEqual(enter(':: t\n:   '), [{ range: { start: { line: 1, character: 0 }, end: { line: 1, character: 4 } }, newText: '' }])
  assert.deepEqual(enter('> :: t\n> : d\n> : '), [
    { range: { start: { line: 2, character: 0 }, end: { line: 2, character: 4 } }, newText: '>' },
    { range: { start: { line: 3, character: 0 }, end: { line: 3, character: 0 } }, newText: '> ' },
  ])
})

test('colon lines that are not description markers are not continued', () => {
  for (const before of [
    ': def',
    'foo\n: bar',
    ':: t\n:',
    ':: t\n:\tdef',
    ':: t\n: \tdef',
    ':: t\n:  \tdef',
    'para\n\n: ',
    '```\n:: t\n: d',
    ':::: note',
  ]) assert.equal(enter(before), null, JSON.stringify(before))
})

test('Enter on a content-less quote line drops one quote level', () => {
  // `> ` ends the quote; `> > ` ends the inner quote and stays in the outer one,
  // as a content-less list marker in a quote does.
  assert.deepEqual(enter('> q\n> '), [{ range: { start: { line: 1, character: 0 }, end: { line: 1, character: 2 } }, newText: '' }])
  assert.deepEqual(enter('> > q\n> > '), [
    { range: { start: { line: 1, character: 0 }, end: { line: 1, character: 4 } }, newText: '>' },
    { range: { start: { line: 2, character: 0 }, end: { line: 2, character: 0 } }, newText: '> ' },
  ])
  assert.deepEqual(enter('> >  '), [
    { range: { start: { line: 0, character: 0 }, end: { line: 0, character: 5 } }, newText: '>' },
    { range: { start: { line: 1, character: 0 }, end: { line: 1, character: 0 } }, newText: '> ' },
  ])
  assert.equal(carveToHtml(`${applied('> > q\n> > ')}x\n`), '<blockquote>\n  <blockquote><p>q</p></blockquote>\n  <p>x</p>\n</blockquote>')
})

test('quote lines with content, or a bare `>`, are not ended', () => {
  // A quote line with content is continued by `continuationPrefix`.
  for (const before of ['> q', '> > q', '> q\n>', '```\n> ']) assert.equal(enter(before), null, JSON.stringify(before))
})

test('the bare continuation marker covers list and definition markers', () => {
  for (const bare of ['- ', '* ', '- [ ] ', '2. ', 'b) ', '. ', ': ', ':   ']) assert.ok(BARE_CONTINUATION_MARKER.test(bare), JSON.stringify(bare))
  for (const text of ['-', ':', ':\t', ': x', '- x', '-\t', '::: ']) assert.ok(!BARE_CONTINUATION_MARKER.test(text), JSON.stringify(text))
})

test('on-type formatting sends a container lead and its closer', async (context) => {
  const client = LspStdioClient.spawnServer(fileURLToPath(new URL('./server.js', import.meta.url)))
  context.after(() => client.stop())
  await client.request('initialize', { processId: null, capabilities: {}, workspaceFolders: [], initializationOptions: {} })
  client.notify('initialized', {})
  client.notify('textDocument/didOpen', {
    textDocument: { uri: 'untitled:fence.crv', languageId: 'carve', version: 1, text: '> ::: note\n\n' },
  })
  const at = { start: { line: 1, character: 0 }, end: { line: 1, character: 0 } }
  assert.deepEqual(await client.request('textDocument/onTypeFormatting', {
    textDocument: { uri: 'untitled:fence.crv' }, position: { line: 1, character: 0 }, ch: '\n',
    options: { tabSize: 2, insertSpaces: true },
  }), [
    { range: at, newText: '> ' },
    { range: { start: { line: 2, character: 0 }, end: { line: 2, character: 0 } }, newText: '> :::\n' },
  ])
})
