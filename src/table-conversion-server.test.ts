import test from 'node:test'
import assert from 'node:assert/strict'
import { fileURLToPath } from 'node:url'
import { LspStdioClient } from './lsp-stdio-client.js'

const uri = 'untitled:table-conversion.crv'
const source = '{table}\n```csv\na,b\nc,d\n```\n\nParagraph\n'

test('offers conversion through refactor code actions', async context => {
  const client = LspStdioClient.spawnServer(fileURLToPath(new URL('./server.js', import.meta.url)))
  context.after(() => client.stop())
  await client.request('initialize', { processId: null, capabilities: {}, workspaceFolders: [] })
  client.notify('initialized', {})
  client.notify('textDocument/didOpen', { textDocument: { uri, languageId: 'carve', version: 1, text: source } })
  const request = async (line: number) => client.request('textDocument/codeAction', {
    textDocument: { uri }, range: { start: { line, character: 0 }, end: { line, character: 0 } },
    context: { diagnostics: [], only: ['refactor'] },
  }) as Promise<{ title: string; edit?: { changes?: Record<string, { newText: string }[]> } }[]>
  const actions = await request(1)
  assert.equal(actions.find(action => action.title === 'Convert to pipe table')?.edit?.changes?.[uri]?.[0]?.newText,
    '|= a |= b |\n| c  | d  |')
  assert.ok(!(await request(7)).some(action => action.title.startsWith('Convert to ')))
})
