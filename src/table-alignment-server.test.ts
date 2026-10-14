import test from 'node:test'
import assert from 'node:assert/strict'
import { fileURLToPath } from 'node:url'
import { LspStdioClient } from './lsp-stdio-client.js'

const source = '|= Name |= Score |\n| 山田太郎 | 10 |\n'
const aligned = '|= Name    |= Score |\n| 山田太郎 | 10     |\n'
const uri = 'untitled:aligned-table.crv'
const options = { tabSize: 2, insertSpaces: true }

test('table alignment setting reaches document, range, on-type and action paths', async context => {
  const client = LspStdioClient.spawnServer(fileURLToPath(new URL('./server.js', import.meta.url)))
  context.after(() => client.stop())
  await client.request('initialize', {
    processId: null,
    capabilities: {},
    workspaceFolders: [],
    initializationOptions: { carve: { format: { alignTables: true } } },
  })
  client.notify('initialized', {})
  client.notify('textDocument/didOpen', {
    textDocument: { uri, languageId: 'carve', version: 1, text: source },
  })
  const full = await client.request('textDocument/formatting', { textDocument: { uri }, options }) as { newText: string }[]
  assert.equal(full[0]?.newText, aligned)

  const range = { start: { line: 1, character: 0 }, end: { line: 1, character: 5 } }
  const selected = await client.request('textDocument/rangeFormatting', { textDocument: { uri }, range, options }) as { newText: string }[]
  assert.equal(selected[0]?.newText, aligned.trimEnd())

  const onType = await client.request('textDocument/onTypeFormatting', {
    textDocument: { uri }, position: { line: 2, character: 0 }, ch: '\n', options,
  }) as { newText: string }[]
  assert.ok(onType.some(edit => edit.newText === aligned.trimEnd()))

  const actions = await client.request('textDocument/codeAction', {
    textDocument: { uri }, range, context: { diagnostics: [] },
  }) as { title: string; edit?: { changes?: Record<string, { newText: string }[]> } }[]
  assert.equal(actions.find(action => action.title === 'Align table')?.edit?.changes?.[uri]?.[0]?.newText, aligned.trimEnd())
})
