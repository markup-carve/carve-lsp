/**
 * Coalesce per-document analysis so a burst of keystrokes produces one run.
 *
 * The server advertises incremental text sync, but analysis is whole-document:
 * every change re-parses, re-resolves, and runs the migration and lint passes.
 * On a book-sized file that crosses interactive latency on its own, and running
 * it once per keystroke multiplies the cost by the typing rate
 * (markup-carve/carve-lsp#68).
 *
 * Scheduling is separated from the server wiring so it can be tested without a
 * connection. The server supplies `run`; this decides WHEN.
 *
 * Two guarantees the caller depends on:
 *
 *  - one run per coalesced burst per URI, never one per edit;
 *  - a run always carries the NEWEST version seen for that URI, so diagnostics
 *    computed for a superseded version are never published. A queued run is
 *    replaced rather than queued behind, which is what makes that true.
 */
export interface DiagnosticSchedulerOptions {
  /**
   * How long to wait for the burst to end. Around 100-150 ms keeps diagnostics
   * feeling immediate while absorbing normal typing; it is a constructor
   * argument rather than a constant so a host can tune it.
   */
  delayMs?: number
  /** Analyze `uri`, which is at `version`. */
  run: (uri: string, version: number) => void
}

/** The default burst window, in milliseconds. */
export const DEFAULT_DIAGNOSTIC_DELAY_MS = 120

export class DiagnosticScheduler {
  private readonly timers = new Map<string, ReturnType<typeof setTimeout>>()
  private readonly versions = new Map<string, number>()
  private readonly delayMs: number
  private readonly run: (uri: string, version: number) => void

  constructor(options: DiagnosticSchedulerOptions) {
    this.delayMs = options.delayMs ?? DEFAULT_DIAGNOSTIC_DELAY_MS
    this.run = options.run
  }

  /**
   * Queue analysis for `uri` at `version`, superseding any queued run for it.
   *
   * Superseding rather than queueing is the whole point: a run already waiting
   * would otherwise publish diagnostics for text the author has since changed.
   */
  schedule(uri: string, version: number): void {
    this.versions.set(uri, version)
    const queued = this.timers.get(uri)
    if (queued !== undefined) clearTimeout(queued)

    const timer = setTimeout(() => {
      this.timers.delete(uri)
      const latest = this.versions.get(uri)
      // `cancel` removes the version, so a document closed while its run was
      // waiting produces no diagnostics for a document that is gone.
      if (latest === undefined) return
      this.run(uri, latest)
    }, this.delayMs)

    this.timers.set(uri, timer)
  }

  /**
   * Analyze `uri` now, dropping any queued run for it.
   *
   * For open and save, where waiting out a burst that is not happening only
   * adds latency.
   */
  flush(uri: string, version: number): void {
    const queued = this.timers.get(uri)
    if (queued !== undefined) {
      clearTimeout(queued)
      this.timers.delete(uri)
    }
    this.versions.set(uri, version)
    this.run(uri, version)
  }

  /** Forget `uri` entirely: no queued run of it will fire. */
  cancel(uri: string): void {
    const queued = this.timers.get(uri)
    if (queued !== undefined) {
      clearTimeout(queued)
      this.timers.delete(uri)
    }
    this.versions.delete(uri)
  }

  /** Drop every queued run. */
  dispose(): void {
    for (const timer of this.timers.values()) clearTimeout(timer)
    this.timers.clear()
    this.versions.clear()
  }

  /** Is a run queued for `uri`? Test and diagnostic aid. */
  pending(uri: string): boolean {
    return this.timers.has(uri)
  }
}
