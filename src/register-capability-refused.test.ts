import test from 'node:test'
import assert from 'node:assert/strict'
import { fileURLToPath } from 'node:url'
import { LspStdioClient } from './lsp-stdio-client.js'

test('keeps serving when the client refuses every capability registration', async (context) => {
  const client = LspStdioClient.spawnServer(fileURLToPath(new URL('./server.js', import.meta.url)))
  client.refuse.add('client/registerCapability')
  context.after(() => client.stop())
  await client.request('initialize', {
    processId: null,
    capabilities: {},
    workspaceFolders: [],
    initializationOptions: {},
  })
  client.notify('initialized', {})
  client.notify('textDocument/didOpen', {
    textDocument: { uri: 'untitled:refused.crv', languageId: 'carve', version: 1, text: '+ item\n' },
  })

  // Both registrations are refused before this request is answered, so an
  // unhandled rejection would have ended the process by now.
  const report = await client.request('textDocument/diagnostic', {
    textDocument: { uri: 'untitled:refused.crv' },
  }) as { kind: string, items: unknown[] }
  assert.equal(report.kind, 'full')
  assert.ok(report.items.length > 0)
  await new Promise((resolve) => setTimeout(resolve, 200))
  assert.equal(client.exitCode, null, 'the server exited')

  const registrations = client.notifications.filter((item) => item.method === 'client/registerCapability')
  assert.equal(registrations.length, 2)
  const logs = client.logMessages().join('\n')
  assert.match(logs, /Could not register configuration change notifications/)
  assert.match(logs, /Could not register file watchers/)
})
