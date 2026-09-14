/**
 * Minimal LSP client over a real child process, for tests that have to observe
 * the SERVER rather than a function it calls.
 *
 * Containment is a property of the server as configured by a client, not of
 * any one module: the root is chosen in `include-settings.ts`, applied in
 * `include-path.ts`, and reported through diagnostics and definition. A unit
 * test that asserts a root is rejected proves the guard exists; only driving
 * the built server over stdio, on a real tree, proves the decision survives
 * the wiring in between.
 *
 * Unlike a bare pipe reader, this answers server-initiated REQUESTS (the
 * watcher registration is one) so the server is never left awaiting a reply
 * that never comes, and it keeps notifications so a test can read the log the
 * server published.
 */
import { spawn, type ChildProcessWithoutNullStreams } from 'node:child_process'

export interface Notification {
  method: string
  params?: unknown
}

export class LspStdioClient {
  readonly #child: ChildProcessWithoutNullStreams
  readonly #pending = new Map<number, (value: unknown) => void>()
  readonly notifications: Notification[] = []
  #next = 1
  #buffer = Buffer.alloc(0)

  constructor(child: ChildProcessWithoutNullStreams) {
    this.#child = child
    child.stdout.on('data', (chunk: Buffer) => {
      this.#buffer = Buffer.concat([this.#buffer, chunk])
      this.#drain()
    })
  }

  /** Spawn `server.js` next to this module, optionally from a given directory. */
  static spawnServer(serverPath: string, cwd?: string): LspStdioClient {
    return new LspStdioClient(
      spawn(process.execPath, [serverPath, '--stdio'], {
        stdio: ['pipe', 'pipe', 'pipe'],
        ...(cwd === undefined ? {} : { cwd }),
      }),
    )
  }

  request(method: string, params: unknown): Promise<unknown> {
    const id = this.#next++
    this.#send({ jsonrpc: '2.0', id, method, params })
    return new Promise((resolve) => this.#pending.set(id, resolve))
  }

  notify(method: string, params: unknown): void {
    this.#send({ jsonrpc: '2.0', method, params })
  }

  /** Every `window/logMessage` the server published, newest last. */
  logMessages(): string[] {
    return this.notifications
      .filter((item) => item.method === 'window/logMessage')
      .map((item) => String((item.params as { message?: unknown } | undefined)?.message ?? ''))
  }

  async stop(): Promise<void> {
    await this.request('shutdown', null)
    this.notify('exit', null)
    this.#child.kill()
  }

  #send(message: unknown): void {
    const body = JSON.stringify(message)
    this.#child.stdin.write(`Content-Length: ${Buffer.byteLength(body)}\r\n\r\n${body}`)
  }

  #drain(): void {
    for (;;) {
      const headerEnd = this.#buffer.indexOf('\r\n\r\n')
      if (headerEnd < 0) return
      const match = /Content-Length: (\d+)/i.exec(this.#buffer.subarray(0, headerEnd).toString())
      if (!match) throw new Error('LSP response omitted Content-Length')
      const end = headerEnd + 4 + Number(match[1])
      if (this.#buffer.length < end) return
      const message = JSON.parse(this.#buffer.subarray(headerEnd + 4, end).toString()) as {
        id?: number
        result?: unknown
        error?: unknown
        method?: string
        params?: unknown
      }
      this.#buffer = this.#buffer.subarray(end)
      if (message.method !== undefined) {
        this.notifications.push({ method: message.method, params: message.params })
        // A server-initiated request left unanswered stalls the server's own
        // await, not just this client.
        if (message.id !== undefined) this.#send({ jsonrpc: '2.0', id: message.id, result: null })
        continue
      }
      if (message.id === undefined) continue
      const resolve = this.#pending.get(message.id)
      if (!resolve) continue
      this.#pending.delete(message.id)
      resolve(message.error ? Promise.reject(message.error) : message.result)
    }
  }
}
