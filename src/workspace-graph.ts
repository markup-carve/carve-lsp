import path from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'
import type { IndexedToken, WorkspaceIndex } from './workspace-index.js'

export type WorkspaceEdgeKind = 'reference' | 'citation' | 'asset' | 'document-link' | 'include'

export interface WorkspaceGraphEdge {
  kind: WorkspaceEdgeKind
  from: string
  to: string | null
  key: string
}

export interface WorkspaceGraphSnapshot {
  documents: string[]
  edges: WorkspaceGraphEdge[]
  unresolved: WorkspaceGraphEdge[]
}

export interface NavigationEntry {
  uri: string
  id: string
  title: string
  line: number
}

/** Semantic and file dependencies used by navigation, audits, and rebuild tooling. */
export function workspaceGraph(index: WorkspaceIndex): WorkspaceGraphSnapshot {
  const documents = index.documents()
  const known = new Set(documents.map(({ uri }) => uri))
  const edges: WorkspaceGraphEdge[] = []

  for (const document of documents) {
    for (const token of document.tokens.filter((item) => !item.declaration)) {
      const definition = index.definitions(token.kind, token.key)[0]
      edges.push({
        kind: token.kind === 'citation' ? 'citation' : 'reference',
        from: document.uri,
        to: definition?.uri ?? null,
        key: token.key,
      })
    }
    for (const dependency of scanFileDependencies(document.uri, document.source)) {
      edges.push({ ...dependency, to: dependency.to && known.has(dependency.to) ? dependency.to : null })
    }
  }

  return {
    documents: [...known].sort(),
    edges: dedupeEdges(edges),
    unresolved: dedupeEdges(edges.filter((edge) => edge.to === null)),
  }
}

export function backlinks(index: WorkspaceIndex, uri: string): WorkspaceGraphEdge[] {
  return workspaceGraph(index).edges.filter((edge) => edge.to === uri)
}

/** Documents which must be reconsidered when `uri` changes, transitively. */
export function rebuildImpact(index: WorkspaceIndex, uri: string): string[] {
  const edges = workspaceGraph(index).edges
  const affected = new Set<string>()
  const pending = [uri]
  while (pending.length > 0) {
    const target = pending.pop()!
    for (const edge of edges) {
      if (edge.to !== target || affected.has(edge.from)) continue
      affected.add(edge.from)
      pending.push(edge.from)
    }
  }
  affected.delete(uri)
  return [...affected].sort()
}

export function generatedNavigation(index: WorkspaceIndex, uri?: string): NavigationEntry[] {
  return index.tokens(uri)
    .filter((token) => token.declaration && token.kind === 'heading')
    .map((token) => ({
      uri: token.uri,
      id: token.key,
      title: token.label ?? token.key,
      line: token.range.start.line,
    }))
    .sort((left, right) => left.uri.localeCompare(right.uri) || left.line - right.line)
}

function scanFileDependencies(uri: string, source: string): WorkspaceGraphEdge[] {
  let directory: string
  try { directory = path.dirname(fileURLToPath(uri)) } catch { return [] }
  const edges: WorkspaceGraphEdge[] = []
  const add = (kind: WorkspaceEdgeKind, target: string): void => {
    if (/^(?:[a-z][a-z\d+.-]*:|#)/i.test(target)) return
    const clean = target.split('#', 1)[0]!
    if (clean.length === 0) return
    edges.push({ kind, from: uri, to: pathToFileURL(path.resolve(directory, clean)).toString(), key: target })
  }
  for (const match of source.matchAll(/!\[[^\]]*\]\(([^\s)]+)(?:\s+[^)]*)?\)/g)) add('asset', match[1]!)
  for (const match of source.matchAll(/(?<!!)\[[^\]]*\]\(([^\s)]+)(?:\s+[^)]*)?\)/g)) add('document-link', match[1]!)
  for (const match of source.matchAll(/\{\{\s*(?:"([^"]+)"|'([^']+)'|([^\s}|]+))/g)) add('include', match[1] ?? match[2] ?? match[3]!)
  return edges
}

function dedupeEdges(edges: WorkspaceGraphEdge[]): WorkspaceGraphEdge[] {
  const seen = new Set<string>()
  return edges.filter((edge) => {
    const identity = `${edge.kind}\0${edge.from}\0${edge.to ?? ''}\0${edge.key}`
    if (seen.has(identity)) return false
    seen.add(identity)
    return true
  })
}
