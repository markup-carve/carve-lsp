/** Bidirectional index from open documents to include paths they depend on. */
export class DependencyIndex {
  readonly #byDocument = new Map<string, Set<string>>()
  readonly #byPath = new Map<string, Set<string>>()

  update(documentUri: string, paths: Iterable<string>): boolean {
    const next = new Set(paths)
    const previous = this.#byDocument.get(documentUri) ?? new Set<string>()
    if (same(previous, next)) return false

    for (const target of previous) {
      const documents = this.#byPath.get(target)
      documents?.delete(documentUri)
      if (documents?.size === 0) this.#byPath.delete(target)
    }
    if (next.size === 0) this.#byDocument.delete(documentUri)
    else this.#byDocument.set(documentUri, next)
    for (const target of next) {
      const documents = this.#byPath.get(target) ?? new Set<string>()
      documents.add(documentUri)
      this.#byPath.set(target, documents)
    }
    return true
  }

  remove(documentUri: string): boolean {
    return this.update(documentUri, [])
  }

  documentsFor(target: string): string[] {
    return [...(this.#byPath.get(target) ?? [])]
  }

  watchedPaths(): string[] {
    return [...this.#byPath.keys()].sort()
  }
}

/** Build a watcher rooted at the nearest existing ancestor, including missing trees. */
export function watcherFor(target: string) {
  let base = path.dirname(target)
  while (!existsSync(base) && base !== path.dirname(base)) base = path.dirname(base)
  const pattern = path.relative(base, target).split(path.sep).map(escapeGlob).join('/')
  return {
    globPattern: {
      baseUri: pathToFileURL(base).toString(),
      pattern,
    },
  }
}

function escapeGlob(name: string): string {
  return name.replace(/([*?{}\[\]])/g, '[$1]')
}

function same(left: Set<string>, right: Set<string>): boolean {
  return left.size === right.size && [...left].every((value) => right.has(value))
}
import { existsSync } from 'node:fs'
import path from 'node:path'
import { pathToFileURL } from 'node:url'
