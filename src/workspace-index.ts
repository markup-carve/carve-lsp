import {
  SymbolKind,
  type Location,
  type Position,
  type Range,
  type SymbolInformation,
  type TextEdit,
  type WorkspaceEdit,
} from 'vscode-languageserver/node.js'
import { parse, resolve, type BlockNode, type InlineNode } from '@markup-carve/carve'

export type IndexedKind = 'heading' | 'caption' | 'footnote' | 'linkref' | 'citation'

export interface IndexedToken {
  kind: IndexedKind
  key: string
  uri: string
  range: Range
  declaration: boolean
  /** A parser-derived heading id which has no authored identifier to replace. */
  generated?: boolean
  label?: string
}

interface IndexedDocument {
  version: number | string
  source: string
  tokens: IndexedToken[]
}

export interface WorkspaceDocument {
  uri: string
  source: string
  tokens: IndexedToken[]
}

/**
 * Versioned semantic inventory shared by workspace-facing LSP features.
 *
 * It deliberately stores authored tokens rather than parser nodes. Nodes are
 * excellent for meaning, but rename/reference edits need the exact source
 * range of the identifier and included files need a stable URI even when the
 * current edit is temporarily malformed.
 */
export class WorkspaceIndex {
  readonly #documents = new Map<string, IndexedDocument>()

  update(uri: string, source: string, version: number | string): void {
    const current = this.#documents.get(uri)
    if (current?.version === version && current.source === source) return
    this.#documents.set(uri, { version, source, tokens: scanDocument(uri, source) })
  }

  remove(uri: string): void {
    this.#documents.delete(uri)
  }

  clear(): void {
    this.#documents.clear()
  }

  tokens(uri?: string): IndexedToken[] {
    if (uri !== undefined) return [...(this.#documents.get(uri)?.tokens ?? [])]
    return [...this.#documents.values()].flatMap((document) => document.tokens)
  }

  documents(): WorkspaceDocument[] {
    return [...this.#documents].map(([uri, document]) => ({
      uri,
      source: document.source,
      tokens: [...document.tokens],
    }))
  }

  tokenAt(uri: string, position: Position): IndexedToken | null {
    const candidates = this.tokens(uri).filter((token) => contains(token.range, position))
    candidates.sort((a, b) => rangeSize(a.range) - rangeSize(b.range))
    return candidates[0] ?? null
  }

  definitions(kind: IndexedKind, key: string): IndexedToken[] {
    return this.tokens().filter((token) => token.declaration && sameIdentity(token, kind, key))
  }

  references(kind: IndexedKind, key: string, includeDeclaration = false): Location[] {
    return this.tokens()
      .filter((token) => (includeDeclaration || !token.declaration) && sameIdentity(token, kind, key))
      .map(({ uri, range }) => ({ uri, range }))
  }

  symbols(query = ''): SymbolInformation[] {
    const wanted = query.toLocaleLowerCase()
    return this.tokens()
      .filter((token) => token.declaration && token.key.toLocaleLowerCase().includes(wanted))
      .map((token) => ({
        name: token.label ?? token.key,
        kind: symbolKind(token.kind),
        location: { uri: token.uri, range: token.range },
        containerName: token.kind,
      }))
  }

  rename(uri: string, position: Position, newName: string): WorkspaceEdit | null {
    const target = this.tokenAt(uri, position)
    if (!target || !isValidName(target.kind, newName)) return null
    const edits = new Map<string, TextEdit[]>()
    for (const token of this.tokens()) {
      if (!sameIdentity(token, target.kind, target.key)) continue
      const entries = edits.get(token.uri) ?? []
      entries.push(token.generated && token.declaration
        ? {
            range: { start: { line: token.range.start.line, character: 0 }, end: { line: token.range.start.line, character: 0 } },
            newText: `{#${newName}}\n`,
          }
        : { range: token.range, newText: newName })
      edits.set(token.uri, entries)
    }
    return { changes: Object.fromEntries(edits) }
  }
}

export function scanDocument(uri: string, source: string): IndexedToken[] {
  const tokens: IndexedToken[] = []
  const lines = source.replace(/\r\n?/g, '\n').split('\n')
  for (let line = 0; line < lines.length; line += 1) {
    const text = lines[line]!

    const heading = /^(#{1,6}) (.*)$/.exec(text)
    if (heading) {
      const explicit = /\{#([^\s}]+)(?:\s[^}]*)?\}\s*$/.exec(heading[2]!)
      if (explicit) push(tokens, uri, 'heading', explicit[1]!, line, text.indexOf(explicit[1]!), true)
    }

    const attributed = /^\{[^}]*#([^\s}]+)[^}]*\}\s*$/.exec(text)
    if (attributed) {
      const next = lines[line + 1] ?? ''
      const kind: IndexedKind = /^#{1,6} /.test(next) ? 'heading' : 'caption'
      push(tokens, uri, kind, attributed[1]!, line, text.indexOf(attributed[1]!), true)
    }

    const footnoteDef = /^(?: {0,3})\[\^([^\]]+)\]:/.exec(text)
    if (footnoteDef) push(tokens, uri, 'footnote', footnoteDef[1]!, line, text.indexOf(footnoteDef[1]!), true)
    const citationDef = /^(?: {0,3})\[@([^\]]+)\]:/.exec(text)
    if (citationDef) push(tokens, uri, 'citation', citationDef[1]!, line, text.indexOf(citationDef[1]!), true)
    const linkDef = /^(?: {0,3})\[([^\]^@][^\]]*)\]:/.exec(text)
    if (linkDef) push(tokens, uri, 'linkref', linkDef[1]!, line, text.indexOf(linkDef[1]!), true)

    for (const match of text.matchAll(/<\/#([^>\s]+)>|\]\(#([^\s)]+)\)/g)) {
      const key = match[1] ?? match[2]!
      const start = match.index! + match[0].indexOf(key)
      push(tokens, uri, 'heading', key, line, start, false)
    }
    for (const match of text.matchAll(/\[\^([^\]]+)\](?!:)/g)) {
      push(tokens, uri, 'footnote', match[1]!, line, match.index! + 2, false)
    }
    for (const match of text.matchAll(/\]\[([^\]]+)\]/g)) {
      if (match[1] === '' || match[1]!.startsWith('^') || match[1]!.startsWith('@')) continue
      push(tokens, uri, 'linkref', match[1]!, line, match.index! + 2, false)
    }
    for (const group of text.matchAll(/\[([^\]]*@[^^\]]+)\]/g)) {
      if (citationDef && group.index === text.indexOf(`[@${citationDef[1]}]`)) continue
      for (const cite of group[1]!.matchAll(/@([\p{L}\p{N}_:.+-]+)/gu)) {
        push(tokens, uri, 'citation', cite[1]!, line, group.index! + 1 + cite.index! + 1, false)
      }
    }
  }
  // Generated heading ids come from the resolver, which is authoritative for
  // Unicode, inline markup, and duplicate suffixes. The lexical inventory
  // above remains available when a document is temporarily malformed.
  try {
    const document = resolve(parse(source, { positions: true }))
    walkBlocks(document.children, (node) => {
      if (node.type !== 'heading' || !node.pos || !node.attrs?.id) return
      const line = node.pos.startLine - 1
      const alreadyAuthored = tokens.some((token) =>
        token.declaration && anchorKind(token.kind) && token.key === node.attrs?.id &&
        (token.range.start.line === line || token.range.start.line === line - 1))
      if (alreadyAuthored) return
      const lineText = lines[line] ?? ''
      const start = Math.min(lineText.length, /^#{1,6}\s+/.exec(lineText)?.[0].length ?? 0)
      tokens.push({
        kind: 'heading', key: node.attrs.id, uri, declaration: true, generated: true,
        label: inlineText(node.children) || node.attrs.id,
        range: { start: { line, character: start }, end: { line, character: lineText.length } },
      })
    })
  } catch {
    // Keep tolerant lexical results while the edit is broken.
  }
  return dedupe(tokens)
}

function walkBlocks(nodes: BlockNode[], visit: (node: BlockNode) => void): void {
  for (const node of nodes) {
    visit(node)
    if ('children' in node && Array.isArray(node.children)) {
      walkBlocks(node.children.filter((child): child is BlockNode =>
        Boolean(child && typeof child === 'object' && 'type' in child && !inlineKinds.has((child as { type: string }).type))), visit)
    }
  }
}

const inlineKinds = new Set(['text', 'softbreak', 'linebreak', 'emph', 'strong', 'underline', 'strikethrough', 'highlight', 'superscript', 'subscript', 'code', 'verbatim', 'math', 'link', 'image', 'crossref', 'footnote', 'citation', 'symbol', 'smart', 'span'])

function inlineText(nodes: InlineNode[]): string {
  return nodes.map((node) => {
    if ('value' in node && typeof node.value === 'string') return node.value
    if ('children' in node && Array.isArray(node.children)) return inlineText(node.children as InlineNode[])
    return ''
  }).join('').trim()
}

function push(
  tokens: IndexedToken[], uri: string, kind: IndexedKind, key: string,
  line: number, character: number, declaration: boolean,
): void {
  tokens.push({
    kind,
    key,
    uri,
    declaration,
    range: {
      start: { line, character },
      end: { line, character: character + key.length },
    },
  })
}

function dedupe(tokens: IndexedToken[]): IndexedToken[] {
  const seen = new Set<string>()
  return tokens.filter((token) => {
    const id = `${token.kind}:${token.key}:${token.range.start.line}:${token.range.start.character}:${token.declaration}`
    if (seen.has(id)) return false
    seen.add(id)
    return true
  })
}

function sameIdentity(token: IndexedToken, kind: IndexedKind, key: string): boolean {
  const sameKind = token.kind === kind || (anchorKind(token.kind) && anchorKind(kind))
  return sameKind && token.key.toLocaleLowerCase() === key.toLocaleLowerCase()
}

function anchorKind(kind: IndexedKind): boolean {
  return kind === 'heading' || kind === 'caption'
}

function contains(range: Range, position: Position): boolean {
  return position.line === range.start.line && position.character >= range.start.character && position.character <= range.end.character
}

function rangeSize(range: Range): number {
  return (range.end.line - range.start.line) * 1_000_000 + range.end.character - range.start.character
}

function symbolKind(kind: IndexedKind): SymbolKind {
  if (kind === 'heading') return SymbolKind.Namespace
  if (kind === 'caption') return SymbolKind.Object
  if (kind === 'citation') return SymbolKind.Key
  return SymbolKind.Variable
}

function isValidName(kind: IndexedKind, value: string): boolean {
  if (value.length === 0 || /[\[\]\r\n]/.test(value)) return false
  if (kind === 'heading' || kind === 'caption' || kind === 'citation') return !/\s/.test(value)
  return true
}
