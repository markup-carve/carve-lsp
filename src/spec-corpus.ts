import { readFileSync } from 'node:fs'

/**
 * The Carve 0.2 conformance corpus of the pinned spec (`spec/0.2/conformance`):
 * every example and clause case that carries a Carve input with default options.
 * Test-only; the server never reads it.
 */
export interface CorpusDocument {
  name: string
  source: string
  expectedHtml?: string
}

const conformance = new URL('../tests/spec/spec/0.2/conformance/', import.meta.url)

export function corpusDocuments(): CorpusDocument[] {
  const out: CorpusDocument[] = []
  const read = (file: string, list: string): void => {
    const data = JSON.parse(readFileSync(new URL(file, conformance), 'utf8')) as Record<string, Array<{ id: string; input?: unknown; options?: object; expected?: { html?: string } }>>
    for (const entry of data[list] ?? []) {
      if (typeof entry.input !== 'string' || Object.keys(entry.options ?? {}).length > 0) continue
      out.push({ name: entry.id, source: entry.input, ...(entry.expected?.html !== undefined ? { expectedHtml: entry.expected.html } : {}) })
    }
  }
  read('examples.json', 'examples')
  read('clause-cases.json', 'cases')
  return out
}
