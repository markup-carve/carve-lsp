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
  type LintPlatform,
} from '@markup-carve/carve'
import path from 'node:path'
import { pathToFileURL } from 'node:url'
import { smartPunctuationText } from './inline-text.js'
import { panelLetter } from './captions.js'
import { resolveIncludes, type IncludeDependency, type IncludeOptions } from './includes.js'
import type { IncludeParseCache } from './include-cache.js'
import { tableDiagnostics } from './table-diagnostics.js'
import { colonFenceStructure } from './colon-fences.js'

export interface AnalyzeOptions {
  /** URI used for diagnostic related-information locations. */
  uri?: string
  lint?: {
    platforms?: readonly LintPlatform[]
    extensions?: readonly string[]
    severities?: Readonly<Record<string, 'error' | 'warning' | 'information' | 'hint' | 'off'>>
  }
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
    const message = error instanceof Error ? error.message : String(error)
    diagnostics.push({
      severity: DiagnosticSeverity.Error,
      range: parseErrorRange(source, message),
      source: 'carve',
      message,
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
  const lintExtensions = (options.lint?.extensions ?? []).map((name) =>
    name === 'semantic-span'
      ? { name, semanticSpanNames: ['samp', 'var', 'cite', 'dfn'] }
      : { name })
  for (const warning of lintCarve(source, {
    platforms: options.lint?.platforms,
    extensions: lintExtensions,
  })) {
    const len = Math.max(1, warning.end - warning.start)
    const diagnostic: Diagnostic = {
      severity: DiagnosticSeverity.Warning,
      range: {
        start: { line: warning.line - 1, character: warning.column - 1 },
        end: { line: warning.line - 1, character: warning.column - 1 + len },
      },
      source: 'carve',
      code: warning.rule,
      message: warning.message,
      data: (warning as typeof warning & { data?: unknown }).data,
    }
    const related = options.uri ? firstDuplicateDeclaration(source, warning.rule, warning.message, warning.line - 1) : null
    if (options.uri && related) diagnostic.relatedInformation = [{
      location: { uri: options.uri, range: related },
      message: 'First declaration is here.',
    }]
    diagnostics.push(diagnostic)
  }

  diagnostics.push(...tableDiagnostics(source))
  // Source intent has disappeared from the AST once a near closer becomes a
  // child div, so this structural source pass complements the engine lint.
  for (const fenceDiagnostic of colonFenceStructure(source).diagnostics) {
    const duplicate = diagnostics.some((diagnostic) =>
      diagnostic.code === fenceDiagnostic.code &&
      diagnostic.range.start.line === fenceDiagnostic.range.start.line &&
      diagnostic.range.start.character === fenceDiagnostic.range.start.character)
    if (!duplicate) diagnostics.push(fenceDiagnostic)
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
    diagnostics: configuredDiagnostics(diagnostics, options.lint?.severities),
    symbols: doc ? documentSymbols(doc) : tolerantHeadingSymbols(source),
    dependencies: includes.dependencies,
    includedSymbols: includedSymbols(includes.documents, options.includedParseCache),
  }
}

function configuredDiagnostics(
  diagnostics: Diagnostic[],
  overrides?: Readonly<Record<string, 'error' | 'warning' | 'information' | 'hint' | 'off'>>,
): Diagnostic[] {
  if (!overrides) return diagnostics
  const levels = {
    error: DiagnosticSeverity.Error,
    warning: DiagnosticSeverity.Warning,
    information: DiagnosticSeverity.Information,
    hint: DiagnosticSeverity.Hint,
  }
  return diagnostics.flatMap((diagnostic) => {
    const configured = diagnostic.code === undefined ? undefined : overrides[String(diagnostic.code)]
    if (!configured) return [diagnostic]
    if (configured === 'off') return []
    return [{ ...diagnostic, severity: levels[configured] }]
  })
}

export function parseErrorRange(source: string, message: string): Range {
  const located = /(?:line|at)\s+(\d+)(?::|,\s*column\s+)(\d+)/i.exec(message)
  if (!located) return rangeAt(source, 0, 1)
  const line = Math.max(0, Number(located[1]) - 1)
  const character = Math.max(0, Number(located[2]) - 1)
  return { start: { line, character }, end: { line, character: character + 1 } }
}

export function tolerantHeadingSymbols(source: string): DocumentSymbol[] {
  const symbols: DocumentSymbol[] = []
  for (const [line, text] of source.replace(/\r\n?/g, '\n').split('\n').entries()) {
    const match = /^(#{1,6}) (.+)$/.exec(text)
    if (!match) continue
    const range = { start: { line, character: 0 }, end: { line, character: text.length } }
    symbols.push({ name: match[2]!, kind: SymbolKind.String, range, selectionRange: range })
  }
  return symbols
}

function firstDuplicateDeclaration(source: string, rule: string, message: string, repeatedLine: number): Range | null {
  const headingKey = rule === 'duplicate-heading-id' ? /heading id "([^"]+)"/.exec(message)?.[1] : undefined
  const footnoteKey = rule === 'duplicate-footnote-definition' ? /\[\^([^\]]+)\]/.exec(message)?.[1] : undefined
  const key = headingKey ?? footnoteKey
  if (!key) return null
  const lines = source.replace(/\r\n?/g, '\n').split('\n')
  const declarations: Range[] = []
  for (let line = 0; line < lines.length; line += 1) {
    const text = lines[line]!
    const match = headingKey
      ? /^\{[^}]*#([^\s}]+)[^}]*\}\s*$/.exec(text)
      : /^(?: {0,3})\[\^([^\]]+)\]:/.exec(text)
    if (!match || match[1]!.toLocaleLowerCase() !== key.toLocaleLowerCase()) continue
    const character = text.indexOf(match[1]!)
    if (line >= repeatedLine - 1) break
    declarations.push({
      start: { line, character },
      end: { line, character: character + match[1]!.length },
    })
  }
  return declarations[0] ?? null
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
    for (const entry of walkOutline(document.children)) {
      // An INCLUDED file contributes its headings, flat. A composite figure is
      // a landmark inside its own file rather than a navigable entry in
      // another one, so it stays out of this list.
      if (entry.type !== 'heading') continue
      const symbol = headingSymbol(entry)
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

  const place = (symbol: DocumentSymbol): void => {
    const parent = stack[stack.length - 1]
    if (parent) {
      parent.symbol.children ??= []
      parent.symbol.children.push(symbol)
    } else {
      roots.push(symbol)
    }
  }

  for (const entry of walkOutline(doc.children)) {
    if (entry.type === 'figure_group') {
      // A composite figure is a structural landmark: one figure holding
      // ordered panels (PART 9 §4c). It takes NO level, so it never pops the
      // heading stack - it hangs under the section it appears in, the way a
      // heading's own children do.
      place(figureGroupSymbol(entry))
      continue
    }
    while (stack.length && stack[stack.length - 1]!.level >= entry.level) {
      stack.pop()
    }
    const symbol = headingSymbol(entry)
    place(symbol)
    stack.push({ level: entry.level, symbol })
  }

  return roots
}

type OutlineEntry = Heading | Extract<BlockNode, { type: 'figure_group' }>

/**
 * The outline's entries in source order: headings, and composite figures.
 *
 * A group is worth an entry where a plain figure is not, because it is a
 * CONTAINER an author folds, navigates and loses their place inside - the same
 * reason it folds. Its panels come with it, so the outline says how many there
 * are without scrolling the fence.
 */
function* walkOutline(nodes: BlockNode[]): Iterable<OutlineEntry> {
  for (const node of nodes) {
    if (node.type === 'heading') yield node
    if (node.type === 'figure_group') {
      yield node
      // Its panels ride on the group's own symbol - a `figure` or `table`
      // yields no entry of its own here - but the walk still DESCENDS through
      // them. A panel can wrap a quote holding headings, and skipping the panel
      // node dropped those headings out of the outline entirely.
      yield* walkOutline(node.children)
      continue
    }
    if ('children' in node && Array.isArray(node.children)) {
      yield* walkOutline(node.children.filter(isBlockNode))
    }
    if (node.type === 'figure') {
      if ('children' in node.target && Array.isArray(node.target.children)) {
        yield* walkOutline(node.target.children.filter(isBlockNode))
      }
    }
  }
}

/** A group's panels are its direct `figure` and `table` children (§4c). */
function isPanel(node: BlockNode): boolean {
  return node.type === 'figure' || node.type === 'table'
}

function figureGroupSymbol(group: Extract<BlockNode, { type: 'figure_group' }>): DocumentSymbol {
  const range = blockRange(group)
  const panels = group.children.filter(isPanel)
  return {
    name: (group.caption ? plainText(group.caption) : '') || 'Composite figure',
    detail: panels.length === 1 ? '1 panel' : `${panels.length} panels`,
    kind: SymbolKind.Struct,
    range,
    selectionRange: range,
    children: panels.map((panel, index) => panelSymbol(panel, index)),
  }
}

/**
 * A panel is named by its own caption, and falls back to the LETTER a crossref
 * would use for it (§4c) - not to a number, which would read as a figure number
 * the panel does not have.
 */
function panelSymbol(panel: BlockNode, index: number): DocumentSymbol {
  const caption = (panel as { caption?: InlineNode[] }).caption
  const range = blockRange(panel)
  return {
    name: (caption ? plainText(caption) : '') || `Panel ${panelLetter(index)}`,
    kind: panel.type === 'table' ? SymbolKind.Array : SymbolKind.Object,
    range,
    selectionRange: range,
    children: [],
  }
}

function blockRange(node: BlockNode): Range {
  if (!node.pos) {
    return { start: { line: 0, character: 0 }, end: { line: 0, character: 0 } }
  }
  return {
    start: { line: node.pos.startLine - 1, character: 0 },
    end: { line: node.pos.endLine - 1, character: 200 },
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
    // A caption's resolved number. Without it a composite figure appeared in
    // the outline as "Figure : Group caption", with the gap where the number
    // the reader is looking for should be.
    else if (node.type === 'caption_number') out += String(node.n)
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
