export class VersionedCache<T> {
  readonly #entries = new Map<string, { version: number | string; value: T }>()

  get(uri: string, version: number | string): T | undefined {
    const entry = this.#entries.get(uri)
    return entry?.version === version ? entry.value : undefined
  }

  set(uri: string, version: number | string, value: T): T {
    this.#entries.set(uri, { version, value })
    return value
  }

  getOrCreate(uri: string, version: number | string, create: () => T): T {
    return this.get(uri, version) ?? this.set(uri, version, create())
  }

  remove(uri: string): void { this.#entries.delete(uri) }
  clear(): void { this.#entries.clear() }
}
