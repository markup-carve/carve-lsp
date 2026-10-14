import { parse, resolve, type Document } from '@markup-carve/carve'

/**
 * `resolve(parse(source))`, memoized for the last few sources.
 *
 * The cache holds the RESOLVED tree because `resolve()` mutates the parsed one
 * in place. Callers share the returned object and must treat it as read-only.
 */
const LIMIT = 4
const entries: Array<{ source: string; doc: Document }> = []

export function resolvedDocument(source: string): Document {
  const index = entries.findIndex((entry) => entry.source === source)
  if (index !== -1) {
    const [hit] = entries.splice(index, 1)
    entries.unshift(hit!)
    return hit!.doc
  }
  const doc = resolve(parse(source, { positions: true }))
  entries.unshift({ source, doc })
  if (entries.length > LIMIT) entries.length = LIMIT
  return doc
}

/** Test seam: forget every cached tree. */
export function clearParseCache(): void {
  entries.length = 0
}
