import test from 'node:test'
import assert from 'node:assert/strict'
import { spawn, type ChildProcessWithoutNullStreams } from 'node:child_process'
import { fileURLToPath } from 'node:url'

test('advertises the expanded protocol surface and serves pull diagnostics', async (context) => {
  const child = spawn(process.execPath, [fileURLToPath(new URL('./server.js', import.meta.url)), '--stdio'], {
    stdio: ['pipe', 'pipe', 'pipe'],
  })
  context.after(() => child.kill())
  const client = new JsonRpcClient(child)
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
  await client.request('shutdown', null)
  client.notify('exit', null)
})

class JsonRpcClient {
  readonly #child: ChildProcessWithoutNullStreams
  readonly #pending = new Map<number, (value: unknown) => void>()
  #next = 1
  #buffer = Buffer.alloc(0)

  constructor(child: ChildProcessWithoutNullStreams) {
    this.#child = child
    child.stdout.on('data', (chunk: Buffer) => {
      this.#buffer = Buffer.concat([this.#buffer, chunk])
      this.#drain()
    })
  }

  request(method: string, params: unknown): Promise<unknown> {
    const id = this.#next++
    this.#send({ jsonrpc: '2.0', id, method, params })
    return new Promise((resolve) => this.#pending.set(id, resolve))
  }

  notify(method: string, params: unknown): void {
    this.#send({ jsonrpc: '2.0', method, params })
  }

  #send(message: unknown): void {
    const body = JSON.stringify(message)
    this.#child.stdin.write(`Content-Length: ${Buffer.byteLength(body)}\r\n\r\n${body}`)
  }

  #drain(): void {
    while (true) {
      const headerEnd = this.#buffer.indexOf('\r\n\r\n')
      if (headerEnd < 0) return
      const match = /Content-Length: (\d+)/i.exec(this.#buffer.subarray(0, headerEnd).toString())
      if (!match) throw new Error('LSP response omitted Content-Length')
      const length = Number(match[1])
      const end = headerEnd + 4 + length
      if (this.#buffer.length < end) return
      const message = JSON.parse(this.#buffer.subarray(headerEnd + 4, end).toString()) as {
        id?: number, result?: unknown, error?: unknown, method?: string
      }
      this.#buffer = this.#buffer.subarray(end)
      if (message.id !== undefined && !message.method) {
        const resolve = this.#pending.get(message.id)
        if (resolve) {
          this.#pending.delete(message.id)
          resolve(message.error ? Promise.reject(message.error) : message.result)
        }
      }
    }
  }
}
