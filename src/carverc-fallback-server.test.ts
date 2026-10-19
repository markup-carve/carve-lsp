import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { LspStdioClient } from './lsp-stdio-client.js'

const source = '|= Name |= Score |\n| 山田太郎 | 10 |\n'
const aligned = '|= Name    |= Score |\n| 山田太郎 | 10     |\n'
const options = { tabSize: 2, insertSpaces: true }

// The payload vscode-carve 0.1.12 sends: a `carve` section without `format`.
const vscodeSection = { formatter: 'conservative', includes: { enabled: 'auto' }, exportActions: false }

async function formatWith(carve: Record<string, unknown> | undefined, rc: unknown, context: test.TestContext): Promise<string | undefined> {
  const root = mkdtempSync(path.join(tmpdir(), 'carve-rc-'))
  writeFileSync(path.join(root, '.carverc.json'), JSON.stringify(rc))
  const uri = pathToFileURL(path.join(root, 'table.crv')).href
  const client = LspStdioClient.spawnServer(fileURLToPath(new URL('./server.js', import.meta.url)))
  context.after(() => client.stop())
  await client.request('initialize', {
    processId: null,
    capabilities: {},
    workspaceFolders: [{ uri: pathToFileURL(root).href, name: 'ws' }],
    initializationOptions: carve ? { carve, workspaceTrusted: true } : { workspaceTrusted: true },
  })
  client.notify('initialized', {})
  client.notify('textDocument/didOpen', { textDocument: { uri, languageId: 'carve', version: 1, text: source } })
  // VS Code sends this on any settings change when no configuration section is synchronized.
  client.notify('workspace/didChangeConfiguration', { settings: null })
  const edits = await client.request('textDocument/formatting', { textDocument: { uri }, options }) as { newText: string }[]
  return edits[0]?.newText
}

test('.carverc.json format.alignTables applies when the client sends a carve section without it', async context => {
  assert.equal(await formatWith(vscodeSection, { carve: { format: { alignTables: true } } }, context), aligned)
})

test('a client value still overrides .carverc.json', async context => {
  const result = await formatWith({ ...vscodeSection, format: { alignTables: false } }, { carve: { format: { alignTables: true } } }, context)
  assert.notEqual(result, aligned)
})

test('didChangeConfiguration with settings null keeps the client section', async context => {
  const result = await formatWith({ ...vscodeSection, format: { alignTables: true } }, {}, context)
  assert.equal(result, aligned)
})
