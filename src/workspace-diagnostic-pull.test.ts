import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, unlinkSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { LspStdioClient } from './lsp-stdio-client.js'

interface Report { uri: string, kind: string, resultId: string, items?: { code?: string }[] }

async function start(context: test.TestContext, root: string): Promise<LspStdioClient> {
  const client = LspStdioClient.spawnServer(fileURLToPath(new URL('./server.js', import.meta.url)))
  context.after(() => client.stop())
  const folder = pathToFileURL(root).href
  await client.request('initialize', { processId: null, capabilities: {}, workspaceFolders: [{ uri: folder, name: 'w' }], initializationOptions: {} })
  client.notify('initialized', {})
  return client
}

const settle = <T>(promise: Promise<T>, ms: number): Promise<T | 'pending'> =>
  Promise.race([promise, new Promise<'pending'>((resolve) => setTimeout(() => resolve('pending'), ms))])

test('an empty workspace answers its first pull instead of holding it', async (context) => {
  const client = await start(context, mkdtempSync(join(tmpdir(), 'ws-diag-empty-')))
  const first = await settle(client.request('workspace/diagnostic', { previousResultIds: [] }), 2_000)
  assert.deepEqual(first, { items: [] })
})

test('a re-pull is held until a change and then reports only the changed document in full', async (context) => {
  const root = mkdtempSync(join(tmpdir(), 'ws-diag-pull-'))
  writeFileSync(join(root, 'a.crv'), '# A\n')
  writeFileSync(join(root, 'b.crv'), '# B\n')
  const client = await start(context, root)

  const first = await client.request('workspace/diagnostic', { previousResultIds: [] }) as { items: Report[] }
  assert.equal(first.items.length, 2)
  assert.ok(first.items.every((item) => item.kind === 'full' && item.resultId))

  const held = client.request('workspace/diagnostic', {
    previousResultIds: first.items.map((item) => ({ uri: item.uri, value: item.resultId })),
  }) as Promise<{ items: Report[] }>
  assert.equal(await settle(held, 500), 'pending', 'an up-to-date re-pull must not be answered at once')

  const a = pathToFileURL(join(root, 'a.crv')).href
  client.notify('textDocument/didOpen', { textDocument: { uri: a, languageId: 'carve', version: 1, text: '# A\n\nSee [x][missing].\n' } })
  const woken = await settle(held, 3_000)
  assert.notEqual(woken, 'pending', 'a change must answer the held pull')
  const byUri = new Map((woken as { items: Report[] }).items.map((item) => [item.uri, item]))
  assert.equal(byUri.get(a)?.kind, 'full')
  assert.deepEqual(byUri.get(a)?.items?.map((item) => item.code), ['workspace-unresolved-linkref'])
  assert.equal(byUri.get(pathToFileURL(join(root, 'b.crv')).href)?.kind, 'unchanged')
})

test('a re-pull with stale result ids is answered at once', async (context) => {
  const root = mkdtempSync(join(tmpdir(), 'ws-diag-stale-'))
  writeFileSync(join(root, 'a.crv'), '# A\n')
  const client = await start(context, root)
  const first = await client.request('workspace/diagnostic', { previousResultIds: [] }) as { items: Report[] }
  const stale = await settle(client.request('workspace/diagnostic', {
    previousResultIds: first.items.map((item) => ({ uri: item.uri, value: 'stale' })),
  }), 2_000) as { items: Report[] } | 'pending'
  assert.notEqual(stale, 'pending')
  assert.equal((stale as { items: Report[] }).items[0]?.kind, 'full')
})

test('a deleted file gets an empty report so the client drops its old entries', async (context) => {
  const root = mkdtempSync(join(tmpdir(), 'ws-diag-deleted-'))
  const path = join(root, 'gone.crv')
  writeFileSync(path, 'See [x][missing].\n')
  const client = await start(context, root)
  const first = await client.request('workspace/diagnostic', { previousResultIds: [] }) as { items: Report[] }
  const uri = pathToFileURL(path).href
  assert.equal(first.items[0]?.items?.length, 1)
  const held = client.request('workspace/diagnostic', {
    previousResultIds: first.items.map((item) => ({ uri: item.uri, value: item.resultId })),
  }) as Promise<{ items: Report[] }>
  unlinkSync(path)
  client.notify('workspace/didChangeWatchedFiles', { changes: [{ uri, type: 3 }] })
  const woken = await settle(held, 3_000)
  assert.notEqual(woken, 'pending')
  assert.deepEqual((woken as { items: Report[] }).items.find((item) => item.uri === uri)?.items, [])
})

test('a pull still naming a deleted file is answered, and the same pull again is held', async (context) => {
  const root = mkdtempSync(join(tmpdir(), 'ws-diag-deleted-early-'))
  const keep = join(root, 'keep.crv')
  const gone = join(root, 'gone.crv')
  writeFileSync(keep, '# Keep\n')
  writeFileSync(gone, '# Gone\n')
  const client = await start(context, root)
  const first = await client.request('workspace/diagnostic', { previousResultIds: [] }) as { items: Report[] }
  const previousResultIds = first.items.map((item) => ({ uri: item.uri, value: item.resultId }))
  unlinkSync(gone)
  client.notify('workspace/didChangeWatchedFiles', { changes: [{ uri: pathToFileURL(gone).href, type: 3 }] })
  await new Promise((resolve) => setTimeout(resolve, 200))
  const answered = await settle(client.request('workspace/diagnostic', { previousResultIds }), 2_000)
  assert.notEqual(answered, 'pending', 'the deleted file has not been reported as removed yet')
  const next = (answered as { items: Report[] }).items.map((item) => ({ uri: item.uri, value: item.resultId }))
  assert.equal(await settle(client.request('workspace/diagnostic', { previousResultIds: next }), 500), 'pending')
})
