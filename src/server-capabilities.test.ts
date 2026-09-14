import test from 'node:test'
import assert from 'node:assert/strict'
import { fileURLToPath } from 'node:url'
import { LspStdioClient } from './lsp-stdio-client.js'

test('advertises the expanded protocol surface and serves pull diagnostics', async (context) => {
  const client = LspStdioClient.spawnServer(fileURLToPath(new URL('./server.js', import.meta.url)))
  context.after(() => client.stop())
  const initialized = await client.request('initialize', {
    processId: null,
    capabilities: {},
    workspaceFolders: [],
    initializationOptions: {},
  }) as { capabilities: Record<string, unknown> }
  for (const capability of [
    'workspaceSymbolProvider', 'documentLinkProvider', 'documentHighlightProvider',
    'selectionRangeProvider', 'inlayHintProvider', 'diagnosticProvider',
  ]) assert.ok(initialized.capabilities[capability], `missing ${capability}`)
  assert.deepEqual(initialized.capabilities.semanticTokensProvider &&
    (initialized.capabilities.semanticTokensProvider as { full: unknown }).full, { delta: true })

  client.notify('initialized', {})
  client.notify('textDocument/didOpen', {
    textDocument: { uri: 'untitled:broken.crv', languageId: 'carve', version: 1, text: '+ item\n' },
  })
  const report = await client.request('textDocument/diagnostic', {
    textDocument: { uri: 'untitled:broken.crv' },
  }) as { kind: string, items: unknown[] }
  assert.equal(report.kind, 'full')
  assert.ok(report.items.length > 0)
})
