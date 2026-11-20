import assert from 'node:assert/strict'
import test from 'node:test'
import { fileURLToPath } from 'node:url'
import { LspStdioClient } from './lsp-stdio-client.js'

// Commands contributed by vscode-carve's package.json on its main branch.
const editorCommands = new Set([
  'carve.openPreview', 'carve.exportHtml', 'carve.exportPdf',
  'carve.exportMarkdown', 'carve.importFile', 'carve.exportBundle',
  'carve.exportFlattened', 'carve.copyFlattened', 'carve.printPreview',
  'carve.restartLanguageServer', 'carve.indentListItem',
  'carve.outdentListItem', 'carve.formatCanonical',
])

const uri = 'file:///command-ownership.crv'

async function initialize(pdfExportCommand?: unknown): Promise<{
  client: LspStdioClient
  commands: string[]
}> {
  const client = LspStdioClient.spawnServer(fileURLToPath(new URL('./server.js', import.meta.url)))
  const result = await client.request('initialize', {
    processId: null,
    capabilities: {},
    workspaceFolders: [],
    initializationOptions: { carve: { pdfExportCommand } },
  }) as { capabilities: { executeCommandProvider: { commands: string[] } } }
  client.notify('initialized', {})
  client.notify('textDocument/didOpen', {
    textDocument: { uri, languageId: 'carve', version: 1, text: '# Export\n' },
  })
  return { client, commands: result.capabilities.executeCommandProvider.commands }
}

async function pdfAction(client: LspStdioClient): Promise<{ command?: { command: string } } | undefined> {
  const actions = await client.request('textDocument/codeAction', {
    textDocument: { uri },
    range: { start: { line: 0, character: 0 }, end: { line: 0, character: 0 } },
    context: { diagnostics: [], only: ['source'] },
  }) as { title: string, command?: { command: string } }[]
  return actions.find(action => action.title === 'Export as PDF')
}

test('default advertised commands do not overlap editor commands and offer no PDF command action', async context => {
  const { client, commands } = await initialize()
  context.after(() => client.stop())
  assert.ok(commands.includes('carve.listIndent'))
  assert.deepEqual(commands.filter(command => editorCommands.has(command)), [])
  assert.equal(await pdfAction(client), undefined)
})

test('PDF command and its code action require an explicit client opt-in', async context => {
  const { client, commands } = await initialize(true)
  context.after(() => client.stop())
  assert.ok(commands.includes('carve.exportPdf'))
  assert.equal((await pdfAction(client))?.command?.command, 'carve.exportPdf')
})
