import assert from 'node:assert/strict'
import test from 'node:test'
import { fileURLToPath } from 'node:url'
import { LspStdioClient } from './lsp-stdio-client.js'
import { planUpgrade, upgradeCodeAction, wantsUpgrade } from './upgrade-action.js'

const uri = 'file:///upgrade.crv'
const range = { start: { line: 0, character: 0 }, end: { line: 0, character: 0 } }

test('the plan is the engine upgrade as edits on the 0.1 source', async () => {
  const plan = await planUpgrade('Über text\n# Heading\n')
  assert.equal(plan.writable, true)
  assert.deepEqual(plan.edits, [{ range: { start: { line: 1, character: 0 }, end: { line: 1, character: 0 } }, newText: '\n' }])
  assert.deepEqual(plan.review, [])
  assert.deepEqual((await planUpgrade('Plain text.\n')).edits, [])
})

test('a CRLF document gets CRLF in the edits', async () => {
  const plan = await planUpgrade('Text\r\n# Heading\r\n')
  assert.deepEqual(plan.edits, [{ range: { start: { line: 1, character: 0 }, end: { line: 1, character: 0 } }, newText: '\r\n' }])
})

test('records that need a person become review diagnostics at their range', async () => {
  const plan = await planUpgrade('Text\n# Heading\n\n[Label]\n:::: tabs\n::: tab\nx\n:::\n::::\n')
  assert.equal(plan.review.length, 1)
  assert.equal(plan.review[0]?.code, 'U-415')
  assert.deepEqual(plan.review[0]?.range.start, { line: 5, character: 0 })
  const action = upgradeCodeAction(uri, plan, false)
  assert.equal(action?.title, 'Upgrade to Carve 0.2 (1 to review)')
  assert.equal(action?.command?.command, 'carve.upgrade')
  assert.match(String((action?.command?.arguments?.[1] as { review: string }).review), /^line 6: U-415 /)
})

test('a document the upgrade would render differently gets no applicable action', async () => {
  const blocked = { edits: [{ range, newText: 'x' }], writable: false, check: 'mismatch', records: [], review: [] }
  assert.equal(upgradeCodeAction(uri, blocked, false), null)
  assert.match(String(upgradeCodeAction(uri, blocked, true)?.disabled?.reason), /render/)
  assert.equal(upgradeCodeAction(uri, blocked, true)?.edit, undefined)
})

test('only a request for source actions runs the upgrade', () => {
  assert.equal(wantsUpgrade(undefined), false)
  assert.equal(wantsUpgrade(['quickfix']), false)
  assert.equal(wantsUpgrade(['source']), true)
  assert.equal(wantsUpgrade(['source.upgrade']), true)
})

test('the server offers the source action and applies carve.upgrade as one edit', async (context) => {
  const client = LspStdioClient.spawnServer(fileURLToPath(new URL('./server.js', import.meta.url)))
  context.after(() => client.stop())
  const initialized = await client.request('initialize', { processId: null, capabilities: {}, workspaceFolders: [], initializationOptions: {} }) as {
    capabilities: { executeCommandProvider: { commands: string[] }, codeActionProvider: { codeActionKinds: string[] } }
  }
  assert.ok(initialized.capabilities.executeCommandProvider.commands.includes('carve.upgrade'))
  assert.ok(initialized.capabilities.codeActionProvider.codeActionKinds.includes('source.upgrade'))
  client.notify('initialized', {})
  client.notify('textDocument/didOpen', { textDocument: { uri, languageId: 'carve', version: 1, text: 'Text\n# Heading\n' } })

  const actions = await client.request('textDocument/codeAction', { textDocument: { uri }, range, context: { diagnostics: [], only: ['source'] } }) as { title: string, kind: string, edit?: unknown }[]
  const upgrade = actions.find((action) => action.kind === 'source.upgrade')
  assert.equal(upgrade?.title, 'Upgrade to Carve 0.2')
  const lightbulb = await client.request('textDocument/codeAction', { textDocument: { uri }, range, context: { diagnostics: [] } }) as { kind: string }[]
  assert.equal(lightbulb.some((action) => action.kind === 'source.upgrade'), false)

  await client.request('workspace/executeCommand', { command: 'carve.upgrade', arguments: [uri] })
  const applyEdit = client.notifications.find((item) => item.method === 'workspace/applyEdit')
  assert.deepEqual((applyEdit?.params as { edit: unknown }).edit, upgrade?.edit)
})
