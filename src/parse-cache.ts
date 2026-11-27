import { parseWithDiagnostics } from './engine.js'

type Parsed = ReturnType<typeof parseWithDiagnostics>

/**
 * The 0.2 tree of `source` with its parse diagnostics, memoized for the last
 * few sources, so the analysis passes and the requests on one version share a
 * single parse. Callers share the returned objects and must treat them as
 * read-only.
 */
const LIMIT = 4
const entries: Array<{ source: string; parsed: Parsed }> = []

export function parsedSource(source: string): Parsed {
  const index = entries.findIndex((entry) => entry.source === source)
  if (index !== -1) {
    const [hit] = entries.splice(index, 1)
    entries.unshift(hit!)
    return hit!.parsed
  }
  const parsed = parseWithDiagnostics(source)
  entries.unshift({ source, parsed })
  if (entries.length > LIMIT) entries.length = LIMIT
  return parsed
}

/** The tree `parse(source)` gives, from the shared parse. */
export function resolvedDocument(source: string): Parsed['document'] {
  return parsedSource(source).document
}

/** Test seam: forget every cached tree. */
export function clearParseCache(): void {
  entries.length = 0
}
