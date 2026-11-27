import { existsSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { Worker } from 'node:worker_threads'
import type { Analysis } from './analyze.js'
import { newAnalysisCaches, runAnalysisJob, type AnalysisJob } from './analysis-job.js'

export type WorkerRequest =
  | { type: 'analyze'; id: number; job: AnalysisJob }
  | { type: 'invalidate'; path: string }

export type WorkerResponse =
  | { id: number; analysis: Analysis }
  | { id: number; error: string }

/** A queued analysis replaced by a newer job for the same document before it started. */
export class SupersededError extends Error {
  constructor() {
    super('superseded by a newer analysis of the same document')
  }
}

interface Pending {
  job: AnalysisJob
  resolve: (analysis: Analysis) => void
  reject: (error: Error) => void
}

export interface AnalysisRunnerOptions {
  /** The worker script; absent or missing on disk runs every analysis inline. */
  workerUrl?: URL
  /** Called once when the worker cannot be used and analyses fall back to the main thread. */
  onFallback?: (reason: string) => void
}

/**
 * Runs analyses one at a time in a worker thread, so a long lint pass does not
 * hold up hover, completion or semantic tokens. A job waiting for its turn is
 * replaced by a newer job for the same URI: only the newest text is analyzed.
 */
export class AnalysisRunner {
  readonly #queue = new Map<string, Pending>()
  readonly #caches = newAnalysisCaches()
  readonly #onFallback: ((reason: string) => void) | undefined
  #worker: Worker | undefined
  #inFlight: { id: number; pending: Pending } | undefined
  #nextId = 1

  constructor(options: AnalysisRunnerOptions = {}) {
    this.#onFallback = options.onFallback
    const url = options.workerUrl
    if (url === undefined) return
    if (!existsSync(fileURLToPath(url))) {
      this.#onFallback?.(`no analysis worker at ${fileURLToPath(url)}`)
      return
    }
    const worker = new Worker(url)
    worker.unref()
    worker.on('message', (response: WorkerResponse) => this.#settle(response))
    worker.on('error', (error) => this.#fail(worker, String(error)))
    worker.on('exit', (code) => this.#fail(worker, `analysis worker exited with code ${code}`))
    this.#worker = worker
  }

  /** True while analyses run in the worker rather than inline. */
  get threaded(): boolean {
    return this.#worker !== undefined
  }

  analyze(job: AnalysisJob): Promise<Analysis> {
    return new Promise((resolve, reject) => {
      const queued = this.#queue.get(job.uri)
      if (queued) {
        this.#queue.delete(job.uri)
        queued.reject(new SupersededError())
      }
      this.#queue.set(job.uri, { job, resolve, reject })
      this.#pump()
    })
  }

  /** Forget cached include source and trees for `path`, here and in the worker. */
  invalidate(path: string): void {
    this.#caches.sources.invalidate(path)
    this.#caches.parses.invalidate(path)
    this.#worker?.postMessage({ type: 'invalidate', path } satisfies WorkerRequest)
  }

  dispose(): void {
    const worker = this.#worker
    this.#worker = undefined
    void worker?.terminate()
    for (const pending of this.#queue.values()) pending.reject(new SupersededError())
    this.#queue.clear()
    this.#inFlight?.pending.reject(new SupersededError())
    this.#inFlight = undefined
  }

  #pump(): void {
    if (this.#inFlight !== undefined) return
    const next = this.#queue.entries().next()
    if (next.done) return
    const [uri, pending] = next.value
    this.#queue.delete(uri)
    const id = this.#nextId++
    this.#inFlight = { id, pending }
    if (this.#worker) {
      this.#worker.postMessage({ type: 'analyze', id, job: pending.job } satisfies WorkerRequest)
      return
    }
    setImmediate(() => {
      try {
        this.#settle({ id, analysis: runAnalysisJob(pending.job, this.#caches) })
      } catch (error) {
        this.#settle({ id, error: error instanceof Error ? (error.stack ?? error.message) : String(error) })
      }
    })
  }

  #settle(response: WorkerResponse): void {
    const inFlight = this.#inFlight
    if (inFlight?.id !== response.id) return
    this.#inFlight = undefined
    if ('analysis' in response) inFlight.pending.resolve(response.analysis)
    else inFlight.pending.reject(new Error(response.error))
    this.#pump()
  }

  #fail(worker: Worker, reason: string): void {
    if (this.#worker !== worker) return
    this.#worker = undefined
    this.#onFallback?.(reason)
    // The job the worker died on runs again inline, ahead of anything queued.
    const inFlight = this.#inFlight
    this.#inFlight = undefined
    if (inFlight) {
      const rest = [...this.#queue]
      this.#queue.clear()
      if (!rest.some(([uri]) => uri === inFlight.pending.job.uri)) this.#queue.set(inFlight.pending.job.uri, inFlight.pending)
      else inFlight.pending.reject(new SupersededError())
      for (const [uri, pending] of rest) this.#queue.set(uri, pending)
    }
    this.#pump()
  }
}
