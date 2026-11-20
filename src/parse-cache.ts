import { parse, type Document } from './engine.js'

/**
 * The 0.2 tree of `source`, memoized for the last few sources. Callers share
 * the returned object and must treat it as read-only.
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
  const doc = parse(source)
  entries.unshift({ source, doc })
  if (entries.length > LIMIT) entries.length = LIMIT
  return doc
}

/** Test seam: forget every cached tree. */
export function clearParseCache(): void {
  entries.length = 0
}
