import test from 'node:test'
import assert from 'node:assert/strict'
import { fileURLToPath } from 'node:url'
import { parse } from '@markup-carve/carve'
import { listIndentEdits, type ContinuationEdit } from './format.js'
import { LspStdioClient } from './lsp-stdio-client.js'

function apply(source: string, edits: ContinuationEdit[]): string {
  const lines = source.split('\n')
  const ordered = [...edits].sort((a, b) => b.range.start.line - a.range.start.line || b.range.start.character - a.range.start.character)
  for (const { range, newText } of ordered) {
    const text = lines[range.start.line]!
    lines[range.start.line] = text.slice(0, range.start.character) + newText + text.slice(range.end.character)
  }
  return lines.join('\n')
}

/** How many list items enclose the item opening `line`, read straight off the engine. */
function depth(source: string, line: number): number | undefined {
  let found: number | undefined
  const visit = (value: unknown, items: number): void => {
    if (found !== undefined) return
    if (Array.isArray(value)) {
      for (const entry of value) visit(entry, items)
      return
    }
    if (value === null || typeof value !== 'object') return
    const node = value as { type?: unknown; pos?: { startLine?: number } }
    if (node.type === 'list_item' && node.pos?.startLine === line + 1) {
      found = items
      return
    }
    for (const [key, child] of Object.entries(node)) if (key !== 'pos') visit(child, items + (node.type === 'list_item' ? 1 : 0))
  }
  visit(parse(source, { positions: true }), 0)
  return found
}

// Each row: source, line, direction, expected source, expected depth of the item afterwards.
const rows: Array<[string, number, 'indent' | 'outdent', string, number]> = [
  ['- a\n- b', 1, 'indent', '- a\n  - b', 1],
  ['* a\n* b', 1, 'indent', '* a\n  * b', 1],
  ['- [ ] a\n- [ ] b', 1, 'indent', '- [ ] a\n  - [ ] b', 1],
  // The child column is the parent's content column, not a fixed width.
  ['1. a\n2. b', 1, 'indent', '1. a\n   1. b', 1],
  ['10. a\n11. b', 1, 'indent', '10. a\n    1. b', 1],
  ['1.  a\n2.  b', 1, 'indent', '1.  a\n    1.  b', 1],
  ['a. a\nb. b', 1, 'indent', 'a. a\n   a. b', 1],
  ['i. a\nii. b', 1, 'indent', 'i. a\n   i. b', 1],
  // Joining a child list takes its next ordinal.
  ['1. a\n   1. x\n2. b', 2, 'indent', '1. a\n   1. x\n   2. b', 1],
  // The item's own lines and children move with it.
  ['- a\n- b\n  more\n  - c', 1, 'indent', '- a\n  - b\n    more\n    - c', 1],
  ['- a\n- b\n\n  para\n- c', 1, 'indent', '- a\n  - b\n\n    para\n- c', 1],
  ['9. a\n10. b\n    more', 1, 'indent', '9. a\n   1. b\n      more', 1],
  // A bare marker right after Enter.
  ['- a\n- ', 1, 'indent', '- a\n  - ', 1],
  ['1. a\n2. ', 1, 'indent', '1. a\n   1. ', 1],
  // Containers.
  ['> - a\n> - b', 1, 'indent', '> - a\n>   - b', 1],
  ['> - a\n> - b\n>   more', 1, 'indent', '> - a\n>   - b\n>     more', 1],
  ['> > - a\n> > - ', 1, 'indent', '> > - a\n> >   - ', 1],
  ['- item\n  > - a\n  > - b', 2, 'indent', '- item\n  > - a\n  >   - b', 2],
  ['[^a]: - a\n  - b\n\nx[^a]', 1, 'indent', '[^a]: - a\n    - b\n\nx[^a]', 1],
  [':: t\n: - a\n  - b', 2, 'indent', ':: t\n: - a\n    - b', 1],
  ['::: note\n- a\n- b\n:::', 2, 'indent', '::: note\n- a\n  - b\n:::', 1],
  // Outdent.
  ['- a\n  - b', 1, 'outdent', '- a\n- b', 0],
  ['- a\n\t- b', 1, 'outdent', '- a\n- b', 0],
  ['- a\n  - ', 1, 'outdent', '- a\n- ', 0],
  ['- a\n  - b\n  - c', 1, 'outdent', '- a\n- b\n  - c', 0],
  ['- a\n  - b\n    - c', 1, 'outdent', '- a\n- b\n  - c', 0],
  ['1. a\n   1. b', 1, 'outdent', '1. a\n2. b', 0],
  ['1. a\n   1. b\n      - c', 1, 'outdent', '1. a\n2. b\n   - c', 0],
  ['1. a\n   - b', 1, 'outdent', '1. a\n- b', 0],
  ['> - a\n>   - b', 1, 'outdent', '> - a\n> - b', 0],
  ['[^a]: - a\n    - b\n\nx[^a]', 1, 'outdent', '[^a]: - a\n  - b\n\nx[^a]', 0],
]

test('Tab and Shift+Tab move a list item to the intended depth', () => {
  for (const [source, line, direction, expected, level] of rows) {
    const edits = listIndentEdits(source, line, direction)
    assert.ok(edits, `${direction} ${JSON.stringify(source)}`)
    const result = apply(source, edits)
    assert.equal(result, expected, `${direction} ${JSON.stringify(source)}`)
    // A bare marker is paragraph text, so check the depth it takes once content lands.
    const completed = result.split('\n').map((text, index) => (index === line && /[ \t]$/.test(text) ? `${text}x` : text)).join('\n')
    assert.equal(depth(completed, line), level, `${direction} ${JSON.stringify(source)}`)
  }
})

test('nothing to nest under or out of leaves Tab to the host', () => {
  for (const [source, line, direction] of [
    ['- a', 0, 'indent'],
    ['- a\n\n- b', 0, 'indent'],
    ['> - a', 0, 'indent'],
    ['[^a]: - a\n\nx[^a]', 0, 'indent'],
    ['- a', 0, 'outdent'],
    ['- a\n- b', 1, 'outdent'],
    ['> - a\n> - b', 1, 'outdent'],
    ['+ a', 0, 'indent'],
    ['- a\n(1) b', 1, 'indent'],
    ['para\n\n- ', 2, 'indent'],
    ['plain', 0, 'indent'],
    ['```\n- a\n- b\n```', 2, 'indent'],
    ['%%%\n- a\n- b\n%%%', 2, 'indent'],
    ['> %%%\n> - a\n> - b\n> %%%', 2, 'indent'],
    ['- a', 5, 'indent'],
    // Tabs under a space-indented item: no width keeps the child nested, so leave it alone.
    ['- a\n  - b\n\t\t- c', 1, 'outdent'],
  ] as const) assert.equal(listIndentEdits(source, line, direction), null, `${direction} ${JSON.stringify(source)}`)
})

test('carve.listIndent returns the edits, or null for the host Tab', async (context) => {
  const client = LspStdioClient.spawnServer(fileURLToPath(new URL('./server.js', import.meta.url)))
  context.after(() => client.stop())
  const uri = 'untitled:indent.crv'
  const initialized = await client.request('initialize', { processId: null, capabilities: {}, workspaceFolders: [], initializationOptions: {} }) as { capabilities: { executeCommandProvider: { commands: string[] } } }
  assert.ok(initialized.capabilities.executeCommandProvider.commands.includes('carve.listIndent'))
  client.notify('initialized', {})
  client.notify('textDocument/didOpen', { textDocument: { uri, languageId: 'carve', version: 1, text: '- a\n- b\n  more\n' } })
  const run = (line: number, direction: string, target = uri) =>
    client.request('workspace/executeCommand', { command: 'carve.listIndent', arguments: [{ uri: target, line, direction }] })
  assert.deepEqual(await run(1, 'indent'), [
    { range: { start: { line: 1, character: 0 }, end: { line: 1, character: 2 } }, newText: '  - ' },
    { range: { start: { line: 2, character: 0 }, end: { line: 2, character: 0 } }, newText: '  ' },
  ])
  assert.equal(await run(0, 'indent'), null)
  assert.equal(await run(1, 'outdent'), null)
  assert.equal(await run(1, 'sideways'), null)
  assert.equal(await run(1, 'indent', 'untitled:missing.crv'), null)
  assert.equal(client.notifications.some((item) => item.method === 'workspace/applyEdit'), false)
})
