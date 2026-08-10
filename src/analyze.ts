import {
  DiagnosticSeverity,
  DocumentSymbol,
  SymbolInformation,
  SymbolKind,
  type Diagnostic,
  type Range,
} from 'vscode-languageserver/node.js'
import {
  djotMigrationWarnings,
  lintCarve,
  parse,
  resolve,
  type BlockNode,
  type Document,
  type Heading,
  type InlineNode,
} from '@markup-carve/carve'
import path from 'node:path'
import { pathToFileURL } from 'node:url'
import { smartPunctuationText } from './inline-text.js'
import { resolveIncludes, type IncludeDependency, type IncludeOptions } from './includes.js'
import type { IncludeParseCache } from './include-cache.js'

export interface AnalyzeOptions {
  /**
   * Include resolution settings (PART 9 §19). ABSENT MEANS OFF: with no
   * options - or with options carrying no resolver - no include directive is
   * acted on and no file is read. §19 requires includes to be opt-in, so the
   * capability has to be handed in rather than defaulted into existence.
   */
  includes?: IncludeOptions
  includedParseCache?: IncludeParseCache
}

export interface Analysis {
  diagnostics: Diagnostic[]
  symbols: DocumentSymbol[]
  /**
   * Include targets touched while analyzing, resolved or not. Empty unless
   * include resolution was enabled. Hosts watch these so a change in an
   * INCLUDED document can re-publish diagnostics for the INCLUDING one.
   */
  dependencies: IncludeDependency[]
  /** Outline entries from included files, carrying their child-file URI. */
  includedSymbols: SymbolInformation[]
}

export function analyzeCarve(source: string, options: AnalyzeOptions = {}): Analysis {
  const diagnostics: Diagnostic[] = []
  let doc: Document | null = null

  try {
    doc = resolve(parse(source))
  } catch (error) {
    diagnostics.push({
      severity: DiagnosticSeverity.Error,
      range: rangeAt(source, 0, 1),
      source: 'carve',
      message: error instanceof Error ? error.message : String(error),
    })
  }

  // warning.start/end are offsets into the line-ending-normalized source;
  // positionAt over that same text yields the precise multi-character range
  // for every rule (including `+` bullets, which the old fix-range lookup
  // could not cover).
  const norm = source.replace(/\r\n?/g, '\n')
  // Diagnostics target hand-written Carve, so surface only the migration
  // constructs that actually mis-render in Carve (`carve-breakage`). Djot
  // semantic shifts that are valid Carve — `_x_` (underline), `~x~`
  // (strikethrough), `{=x=}` (highlight) — are intentional here, not mistakes,
  // so they must not raise editor diagnostics. Their quick fixes remain
  // available through `migrationCodeActions` for anyone migrating from Djot.
  for (const warning of djotMigrationWarnings(source)) {
    if (warning.category !== 'carve-breakage') continue
    diagnostics.push({
      severity: DiagnosticSeverity.Warning,
      range: {
        start: positionAt(norm, warning.start),
        end: positionAt(norm, warning.end),
      },
      source: 'carve',
      code: warning.rule,
      message: `${warning.message} Suggestion: ${warning.suggestion}`,
    })
  }

  // Silent-failure lint: markup that parses but renders as the wrong thing
  // (broken cross-references, duplicate heading ids, trailing heading
  // attributes, legacy raw fences, leaked block markers).
  for (const warning of lintCarve(source)) {
    const len = Math.max(1, warning.end - warning.start)
    diagnostics.push({
      severity: DiagnosticSeverity.Warning,
      range: {
        start: { line: warning.line - 1, character: warning.column - 1 },
        end: { line: warning.line - 1, character: warning.column - 1 + len },
      },
      source: 'carve',
      code: warning.rule,
      message: warning.message,
    })
  }

  // Include resolution (PART 9 §19). Inert without a resolver, so a document
  // in an untrusted or unconfigured workspace keeps its `{{ … }}` literal and
  // nothing on disk is touched.
  const includes = resolveIncludes(norm, options.includes ?? {})
  for (const warning of includes.warnings) {
    diagnostics.push({
      severity: DiagnosticSeverity.Warning,
      range: {
        start: positionAt(norm, warning.start),
        end: positionAt(norm, warning.end),
      },
      source: 'carve',
      code: warning.rule,
      // `warning.detail` is deliberately not folded in: §19 I7 keeps the
      // failure class out of author-visible text so a denial cannot be used
      // to probe host layout. The attributed child is named relative to the
      // include root for the same reason - never as an absolute path.
      message: attributeToChild(warning.message, warning.file, options.includes),
    })
  }

  return {
    diagnostics,
    symbols: doc ? documentSymbols(doc) : [],
    dependencies: includes.dependencies,
    includedSymbols: includedSymbols(includes.documents, options.includedParseCache),
  }
}

function includedSymbols(
  documents: Array<{ id: string; source: string; version?: string }>,
  cache: IncludeParseCache | undefined,
): SymbolInformation[] {
  const symbols: SymbolInformation[] = []
  for (const child of documents) {
    let document = child.version === undefined ? undefined : cache?.get(child.id, child.version)
    if (!document) {
      try {
        document = resolve(parse(child.source))
      } catch {
        continue
      }
      if (child.version !== undefined) cache?.set(child.id, child.version, document)
    }
    const uri = pathToFileURL(child.id).toString()
    for (const heading of walkHeadings(document.children)) {
      const symbol = headingSymbol(heading)
      symbols.push({
        name: symbol.name,
        kind: symbol.kind,
        location: { uri, range: symbol.range },
        containerName: path.basename(child.id),
      })
    }
  }
  return symbols
}

/**
 * Name the file a nested include warning arose in, relative to the include
 * root. A warning raised in the document the client already has open adds
 * nothing and is left alone.
 */
function attributeToChild(
  message: string,
  file: string | undefined,
  includes: IncludeOptions | undefined,
): string {
  if (file === undefined || file === includes?.sourcePath) return message
  return `${message} (in ${relativeToRoot(file, includes?.includeRoot)})`
}

/**
 * A child's identity as the author wrote it: relative to the include root,
 * segment-wise, so a sibling directory named `..foo` is not mistaken for an
 * escape. A file that is not under the root at all is named as it came, since
 * inventing a relative form for it would be a lie.
 */
function relativeToRoot(file: string, root: string | undefined): string {
  if (root === undefined) return file
  const relative = path.relative(root, file)
  if (!relative || path.isAbsolute(relative)) return file
  if (relative.split(path.sep)[0] === '..') return file
  return relative
}

function documentSymbols(doc: Document): DocumentSymbol[] {
  const stack: Array<{ level: number; symbol: DocumentSymbol }> = []
  const roots: DocumentSymbol[] = []

  for (const heading of walkHeadings(doc.children)) {
    const symbol = headingSymbol(heading)
    while (stack.length && stack[stack.length - 1]!.level >= heading.level) {
      stack.pop()
    }
    const parent = stack[stack.length - 1]
    if (parent) {
      parent.symbol.children ??= []
      parent.symbol.children.push(symbol)
    } else {
      roots.push(symbol)
    }
    stack.push({ level: heading.level, symbol })
  }

  return roots
}

function* walkHeadings(nodes: BlockNode[]): Iterable<Heading> {
  for (const node of nodes) {
    if (node.type === 'heading') yield node
    if ('children' in node && Array.isArray(node.children)) {
      yield* walkHeadings(node.children.filter(isBlockNode))
    }
    if (node.type === 'figure') {
      if ('children' in node.target && Array.isArray(node.target.children)) {
        yield* walkHeadings(node.target.children.filter(isBlockNode))
      }
    }
  }
}

function isBlockNode(node: unknown): node is BlockNode {
  return Boolean(node && typeof node === 'object' && 'type' in node)
}

function headingSymbol(heading: Heading): DocumentSymbol {
  const range = heading.pos
    ? {
        start: { line: heading.pos.startLine - 1, character: 0 },
        end: { line: heading.pos.endLine - 1, character: 200 },
      }
    : {
        start: { line: 0, character: 0 },
        end: { line: 0, character: 0 },
      }
  return {
    name: plainText(heading.children) || `Heading ${heading.level}`,
    kind: SymbolKind.String,
    range,
    selectionRange: range,
    children: [],
  }
}

function plainText(nodes: InlineNode[]): string {
  let out = ''
  for (const node of nodes) {
    if (node.type === 'text') out += node.value
    else if ('children' in node && Array.isArray(node.children)) {
      out += plainText(node.children as InlineNode[])
    } else if (node.type === 'code') out += node.value
    // An inline literal (§27) renders as visible prose, so it contributes its
    // verbatim content to the outline symbol name just as a code span does.
    else if (node.type === 'literal_inline') out += node.content
    else if (node.type === 'symbol') out += `:${node.name}:`
    else if (node.type === 'mention') out += `@${node.user}`
    else if (node.type === 'tag') out += `#${node.name}`
    else out += smartPunctuationText(node)
  }
  return out.trim()
}

function positionAt(source: string, offset: number) {
  const before = source.slice(0, offset)
  const line = before.split('\n').length - 1
  const lastNewline = before.lastIndexOf('\n')
  return {
    line,
    character: offset - lastNewline - 1,
  }
}

function rangeAt(source: string, index: number, length: number): Range {
  const before = source.slice(0, index)
  const line = before.split('\n').length - 1
  const lastNewline = before.lastIndexOf('\n')
  const character = index - lastNewline - 1
  return {
    start: { line, character },
    end: { line, character: character + length },
  }
}
