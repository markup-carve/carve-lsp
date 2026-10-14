import {
  DiagnosticSeverity,
  SymbolKind,
  type Diagnostic,
  type Location,
  type Position,
  type Range,
  type SymbolInformation,
  type TextEdit,
  type WorkspaceEdit,
} from 'vscode-languageserver-types'
import { inVerbatim, referenceModel } from './reference-sites.js'

export type IndexedKind = 'heading' | 'caption' | 'footnote' | 'linkref' | 'citation'

export interface IndexedToken {
  kind: IndexedKind
  key: string
  uri: string
  range: Range
  declaration: boolean
  /** A parser-derived heading id which has no authored identifier to replace. */
  generated?: boolean
  /** Text before a generated heading's `#`, i.e. its container prefix. */
  prefix?: string
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

  /** `from` scopes the file-local namespaces (footnotes, link references) to one document. */
  definitions(kind: IndexedKind, key: string, from?: string): IndexedToken[] {
    return this.tokens().filter((token) => token.declaration && sameIdentity(token, kind, key, from))
  }

  references(kind: IndexedKind, key: string, includeDeclaration = false, from?: string): Location[] {
    return this.tokens()
      .filter((token) => (includeDeclaration || !token.declaration) && sameIdentity(token, kind, key, from))
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

  diagnostics(uri: string): Diagnostic[] {
    const diagnostics: Diagnostic[] = []
    const tokens = this.tokens(uri)
    for (const token of tokens) {
      if (!token.declaration && this.definitions(token.kind, token.key, uri).length === 0) {
        diagnostics.push({
          range: token.range,
          severity: DiagnosticSeverity.Warning,
          source: 'carve-workspace',
          code: `workspace-unresolved-${token.kind}`,
          message: `No ${token.kind} declaration named ${JSON.stringify(token.key)} exists in the workspace.`,
        })
      }
      // A generated id is disambiguated by the parser and never reported as a collision.
      if (token.declaration && !token.generated) {
        const declarations = this.definitions(token.kind, token.key, uri).filter((declaration) => !declaration.generated)
        const first = declarations[0]
        if (declarations.length > 1 && first && (first.uri !== token.uri || first.range.start.line !== token.range.start.line)) {
          diagnostics.push({
            range: token.range,
            severity: DiagnosticSeverity.Error,
            source: 'carve-workspace',
            code: `workspace-duplicate-${token.kind}`,
            message: `Duplicate workspace ${token.kind} declaration ${JSON.stringify(token.key)}.`,
            relatedInformation: [{ location: { uri: first.uri, range: first.range }, message: 'First declaration' }],
          })
        }
      }
    }
    return diagnostics
  }

  rename(uri: string, position: Position, newName: string): WorkspaceEdit | null {
    const target = this.tokenAt(uri, position)
    if (!target || !isValidName(target.kind, newName)) return null
    const edits = new Map<string, TextEdit[]>()
    for (const token of this.tokens()) {
      if (!sameIdentity(token, target.kind, target.key, uri)) continue
      const entries = edits.get(token.uri) ?? []
      entries.push(token.generated && token.declaration
        ? {
            range: { start: { line: token.range.start.line, character: (token.prefix ?? '').length }, end: { line: token.range.start.line, character: (token.prefix ?? '').length } },
            newText: `{#${newName}}\n${continuation(token.prefix ?? '')}`,
          }
        : { range: token.range, newText: newName })
      edits.set(token.uri, entries)
    }
    return { changes: Object.fromEntries(edits) }
  }
}

export function scanDocument(uri: string, source: string): IndexedToken[] {
  const model = referenceModel(source)
  const tokens: IndexedToken[] = []
  for (const site of model.sites) {
    if (site.implicit) continue
    const range = site.keyRange ?? (site.generated ? site.range : null)
    if (!range) continue
    const token: IndexedToken = { kind: site.kind, key: site.key, uri, declaration: site.declaration, range }
    if (site.generated) token.generated = true
    if (site.prefix) token.prefix = site.prefix
    if (site.kind === 'heading' && site.declaration && site.label) token.label = site.label
    tokens.push(token)
  }
  // Citations are an extension the core parser does not build, so they are
  // read from the text outside verbatim content.
  const { lines } = model
  let offset = 0
  for (let line = 0; line < lines.length; line += 1) {
    const lineText = lines[line]!
    const lineStart = offset
    offset += lineText.length + 1
    const skip = (character: number): boolean => inVerbatim(model, lineStart + character)
    const citationDef = /^(?: {0,3})\[@([^\]]+)\]:/.exec(lineText)
    if (citationDef && !skip(lineText.indexOf('[@'))) push(tokens, uri, 'citation', citationDef[1]!, line, lineText.indexOf(citationDef[1]!), true)
    for (const group of lineText.matchAll(/\[([^[\]]*@[^^[\]]+)\]/g)) {
      if (citationDef && group.index === lineText.indexOf(`[@${citationDef[1]}]`)) continue
      for (const cite of group[1]!.matchAll(/@([\p{L}\p{N}_:.+-]+)/gu)) {
        const character = group.index! + 1 + cite.index! + 1
        if (!skip(character)) push(tokens, uri, 'citation', cite[1]!, line, character, false)
      }
    }
  }
  tokens.sort((a, b) => a.range.start.line - b.range.start.line || a.range.start.character - b.range.start.character)
  return dedupe(tokens)
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

function sameIdentity(token: IndexedToken, kind: IndexedKind, key: string, from?: string): boolean {
  const sameKind = token.kind === kind || (anchorKind(token.kind) && anchorKind(kind))
  if (!sameKind || token.key !== key) return false
  return from === undefined || !fileLocal(kind) || token.uri === from
}

/** Footnote labels and link-reference labels resolve inside the document that writes them. */
function fileLocal(kind: IndexedKind): boolean {
  return kind === 'footnote' || kind === 'linkref'
}

/** A container prefix as a continuation line spells it: quote markers kept, list and footnote markers blanked. */
function continuation(prefix: string): string {
  return prefix.replace(/[^>\s]/g, ' ')
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
  // An id is written as `{#id}`, which admits only the lexical explicit_identifier.
  if (kind === 'heading' || kind === 'caption') return /^[A-Za-z0-9_][A-Za-z0-9_-]*$/.test(value)
  if (kind === 'citation') return !/\s/.test(value)
  if (kind === 'linkref') return !/^[@^]/.test(value)
  return true
}
