import {
  CompletionItemKind,
  MarkupKind,
  type CompletionItem,
  type Hover,
  type Position,
  type Range,
} from 'vscode-languageserver-types'
import { parse, renderWithDiagnostics, type Document } from './engine.js'
import { walkNodes, type AstNode } from './ast-walk.js'
import { resolveIncludes, v2IncludeConfig, type IncludeOptions } from './includes.js'
import { astOffsetToIndex } from './position.js'
import { resolvedDocument } from './parse-cache.js'
import { inVerbatim, referenceModel, siteAt } from './reference-sites.js'

export interface SnippetDefinition {
  name: string
  /** The value as written: the rest of the marker line (C2-B-236). */
  value: string
  /** The included file's id, or undefined for the document itself. */
  file?: string
}

/** A snippet use is `{{`, spaces, `$` and a name (C2-I-128). */
export const SNIPPET_USE_TEXT = /\{\{ +\$/

/**
 * The definitions of the expanded tree in document order, so the first of a
 * name is the one that wins (C2-N-090). Without a resolver only the document's own.
 */
export function snippetDefinitions(source: string, includes?: IncludeOptions): SnippetDefinition[] {
  const text = source.replace(/\r\n?/g, '\n')
  const config = includes?.resolver ? v2IncludeConfig(includes) : undefined
  let doc: Document
  try {
    doc = config ? parse(text, { includes: config }) : resolvedDocument(text)
  } catch {
    return []
  }
  const children = config ? resolveIncludes(text, includes!).documents : []
  const definitions: SnippetDefinition[] = []
  walkNodes(doc, (node) => {
    if (node.type !== 'snippet_definition' || typeof node.name !== 'string') return
    const file = (node.pos as { file?: string } | undefined)?.file
    const owner = file === undefined ? text : children.find((child) => child.id === file)?.source
    definitions.push({ name: node.name, value: owner === undefined ? '' : valueText(owner, node), ...(file === undefined ? {} : { file }) })
    return false
  })
  return definitions
}

function valueText(source: string, node: AstNode): string {
  const children = Array.isArray(node.children) ? node.children as AstNode[] : []
  const first = children.find((child) => child.pos?.startOffset !== undefined)
  const end = node.pos?.endOffset
  if (!first || end === undefined) return ''
  return source.slice(astOffsetToIndex(source, first.pos!.startOffset!), astOffsetToIndex(source, end))
}

/** After `{{ $` and a partial name: every name in scope, the value as detail. */
export function snippetCompletions(source: string, position: Position, includes?: IncludeOptions): CompletionItem[] {
  const line = source.replace(/\r\n?/g, '\n').split('\n')[position.line] ?? ''
  const match = /\{\{ +\$([A-Za-z0-9_-]*)$/.exec(line.slice(0, position.character))
  if (!match) return []
  const model = referenceModel(source)
  if (inVerbatim(model, model.offsetAt({ line: position.line, character: match.index }))) return []
  const partial = match[1]!
  const seen = new Set<string>()
  const items: CompletionItem[] = []
  for (const definition of snippetDefinitions(source, includes)) {
    if (seen.has(definition.name)) continue
    seen.add(definition.name)
    items.push({
      label: `$${definition.name}`,
      kind: CompletionItemKind.Constant,
      detail: definition.value,
      filterText: definition.name,
      textEdit: {
        range: { start: { line: position.line, character: position.character - partial.length }, end: position },
        newText: definition.name,
      },
    })
  }
  return items
}

/**
 * On a use: the winning definition's value as Carve source, or the engine's
 * finding when the use is not expanded (C2-N-093).
 */
export function snippetHover(source: string, position: Position, includes?: IncludeOptions): Hover | null {
  if (!SNIPPET_USE_TEXT.test(source)) return null
  const model = referenceModel(source)
  const use = siteAt(model, position, (site) => site.kind === 'snippet' && !site.declaration)
  if (!use) return null
  const range = use.range
  const finding = expansionFinding(model.text, range, model.offsetAt.bind(model), includes)
  if (finding) return { contents: { kind: MarkupKind.Markdown, value: `**Snippet \`$${use.key}\`**\n\n${finding}` }, range }
  const definition = snippetDefinitions(source, includes).find((candidate) => candidate.name === use.key)
  if (!definition) return null
  const fence = '`'.repeat(Math.max(3, longestRun(definition.value, '`') + 1))
  return {
    contents: { kind: MarkupKind.Markdown, value: `**Snippet \`$${use.key}\`**\n\n${fence}carve\n${definition.value}\n${fence}` },
    range,
  }
}

function expansionFinding(text: string, range: Range, offsetAt: (position: Position) => number, includes: IncludeOptions | undefined): string | null {
  const config = includes?.resolver ? v2IncludeConfig(includes) : undefined
  let diagnostics
  try {
    diagnostics = renderWithDiagnostics(text, config ? { includes: config } : {}).diagnostics
  } catch {
    return null
  }
  const start = offsetAt(range.start)
  for (const entry of diagnostics) {
    if (!entry.code.startsWith('snippet-') || entry.file !== undefined || !entry.range) continue
    if (astOffsetToIndex(text, entry.range.startOffset) === start) return entry.message
  }
  return null
}

function longestRun(text: string, char: string): number {
  let longest = 0
  let run = 0
  for (const each of text) {
    run = each === char ? run + 1 : 0
    longest = Math.max(longest, run)
  }
  return longest
}
