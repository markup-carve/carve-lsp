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
  // 0.2 lint-rules.json: `djot-plus-bullet` is opt-in, so the sample uses a rule that is on by default.
  client.notify('textDocument/didOpen', {
    textDocument: { uri: 'untitled:broken.crv', languageId: 'carve', version: 1, text: '**bold**\n' },
  })
  const report = await client.request('textDocument/diagnostic', {
    textDocument: { uri: 'untitled:broken.crv' },
  }) as { kind: string, items: unknown[] }
  assert.equal(report.kind, 'full')
  assert.ok(report.items.length > 0)
})

const pullCapabilities = { textDocument: { diagnostic: {} }, workspace: { diagnostics: { refreshSupport: true } } }

async function openBroken(capabilities: unknown, context: test.TestContext): Promise<LspStdioClient> {
  const client = LspStdioClient.spawnServer(fileURLToPath(new URL('./server.js', import.meta.url)))
  context.after(() => client.stop())
  await client.request('initialize', { processId: null, capabilities, workspaceFolders: [], initializationOptions: {} })
  client.notify('initialized', {})
  client.notify('textDocument/didOpen', {
    textDocument: { uri: 'untitled:broken.crv', languageId: 'carve', version: 1, text: '**bold**\n' },
  })
  return client
}

const published = (client: LspStdioClient) => client.notifications.filter((entry) => entry.method === 'textDocument/publishDiagnostics')

test('a client that pulls gets no pushed copy of the same diagnostics', async (context) => {
  const client = await openBroken(pullCapabilities, context)
  const report = await client.request('textDocument/diagnostic', { textDocument: { uri: 'untitled:broken.crv' } }) as { items: unknown[] }
  assert.ok(report.items.length > 0)
  // Outlast the diagnostic debounce, so a push would have arrived.
  await new Promise((resolve) => setTimeout(resolve, 500))
  assert.deepEqual(published(client), [])
})

test('a client without pull support still gets pushed diagnostics', async (context) => {
  const client = await openBroken({}, context)
  const deadline = Date.now() + 3000
  while (Date.now() < deadline && published(client).length === 0) await new Promise((resolve) => setTimeout(resolve, 25))
  assert.ok(published(client).length > 0)
})

test('a document pull with the current result id is answered unchanged', async (context) => {
  const client = await openBroken(pullCapabilities, context)
  const first = await client.request('textDocument/diagnostic', { textDocument: { uri: 'untitled:broken.crv' } }) as { kind: string, resultId: string }
  assert.equal(first.kind, 'full')
  assert.ok(first.resultId)
  const second = await client.request('textDocument/diagnostic', {
    textDocument: { uri: 'untitled:broken.crv' }, previousResultId: first.resultId,
  }) as { kind: string, resultId: string, items?: unknown }
  assert.deepEqual(second, { kind: 'unchanged', resultId: first.resultId })
  client.notify('textDocument/didChange', {
    textDocument: { uri: 'untitled:broken.crv', version: 2 }, contentChanges: [{ text: 'Clean text.\n' }],
  })
  const third = await client.request('textDocument/diagnostic', {
    textDocument: { uri: 'untitled:broken.crv' }, previousResultId: first.resultId,
  }) as { kind: string, items: unknown[] }
  assert.equal(third.kind, 'full')
  assert.deepEqual(third.items, [])
})
