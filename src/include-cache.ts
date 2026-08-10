export interface CachedInclude {
  source: string
  bytes: number
}

interface Entry extends CachedInclude {
  mtimeMs: number
  size: number
}

/** Bounded LRU cache for include source, validated by file metadata. */
export class IncludeSourceCache {
  readonly #entries = new Map<string, Entry>()

  constructor(readonly maxEntries = 128) {}

  get(id: string, mtimeMs: number, size: number): CachedInclude | undefined {
    const entry = this.#entries.get(id)
    if (!entry || entry.mtimeMs !== mtimeMs || entry.size !== size) {
      if (entry) this.#entries.delete(id)
      return undefined
    }
    this.#entries.delete(id)
    this.#entries.set(id, entry)
    return { source: entry.source, bytes: entry.bytes }
  }

  set(id: string, mtimeMs: number, size: number, value: CachedInclude): void {
    this.#entries.delete(id)
    this.#entries.set(id, { ...value, mtimeMs, size })
    while (this.#entries.size > this.maxEntries) {
      const oldest = this.#entries.keys().next().value as string | undefined
      if (oldest === undefined) break
      this.#entries.delete(oldest)
    }
  }

  invalidate(id: string): void {
    this.#entries.delete(id)
  }

  clear(): void {
    this.#entries.clear()
  }

  get size(): number {
    return this.#entries.size
  }
}

interface ParsedEntry {
  version: string
  document: Document
}

/** Bounded LRU cache for parsed child documents. */
export class IncludeParseCache {
  readonly #entries = new Map<string, ParsedEntry>()

  constructor(readonly maxEntries = 128) {}

  get(id: string, version: string): Document | undefined {
    const entry = this.#entries.get(id)
    if (!entry || entry.version !== version) {
      if (entry) this.#entries.delete(id)
      return undefined
    }
    this.#entries.delete(id)
    this.#entries.set(id, entry)
    return entry.document
  }

  set(id: string, version: string, document: Document): void {
    this.#entries.delete(id)
    this.#entries.set(id, { version, document })
    while (this.#entries.size > this.maxEntries) {
      const oldest = this.#entries.keys().next().value as string | undefined
      if (oldest === undefined) break
      this.#entries.delete(oldest)
    }
  }

  invalidate(id: string): void {
    this.#entries.delete(id)
  }

  clear(): void {
    this.#entries.clear()
  }
}
import type { Document } from '@markup-carve/carve'
