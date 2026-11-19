import { SEMANTIC_SPAN_EXTENSION_NAMES } from './semantic-span-names.js'
import {
  DiagnosticSeverity,
  DocumentSymbol,
  SymbolInformation,
  SymbolKind,
  type Diagnostic,
  type Range,
} from 'vscode-languageserver-types'
import {
  CarveOptionError,
  lint,
  parse,
  type BlockNode,
  type CaptionNode,
  type Document,
  type EngineDiagnostic,
  type Heading,
  type IncludeConfig,
  type InlineNode,
  type LintOptions,
} from './engine.js'
import { portableIncludePaths, type IncludePaths } from './include-paths.js'
import { smartPunctuationText } from './inline-text.js'
import { panelLetter } from './captions.js'
import { includeDenialCode } from './include-denial.js'
import {
  resolveIncludes,
  v2IncludeConfig,
  type IncludeDependency,
  type IncludeOptions,
  type IncludeResolution,
  type IncludeWarning,
} from './includes.js'
import type { IncludeParseCache } from './include-cache.js'
import { tableDiagnostics } from './table-diagnostics.js'
import { colonFenceStructure } from './colon-fences.js'
import { astOffsetToIndex, codepointOffsetToIndex, sourceLines } from './position.js'
import { walkNodes } from './ast-walk.js'
import { headingSections } from './folding.js'
import { resolvedDocument } from './parse-cache.js'
import { captionInlines, isFigure, ownStartLine } from './tree.js'

export interface AnalyzeOptions {
  /** URI used for diagnostic related-information locations. */
  uri?: string
  lint?: {
    platforms?: readonly 'github'[]
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
  sourceOfLastAnalysis = source
  const diagnostics: Diagnostic[] = []
  let doc: Document | null = null

  try {
    doc = resolvedDocument(source)
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error)
    diagnostics.push({
      severity: DiagnosticSeverity.Error,
      range: parseErrorRange(source, message),
      source: 'carve',
      message,
    })
  }

  const norm = source.replace(/\r\n?/g, '\n')
  const includes = resolveIncludes(norm, options.includes ?? {})
  const paths = options.includes?.paths ?? portableIncludePaths
  const includeConfig = v2IncludeConfig(options.includes ?? {})
  let lintDiagnostics: EngineDiagnostic[] = []
  const lintOptions = {
    ...(options.lint?.platforms?.length ? { platforms: options.lint.platforms } : {}),
    ...(includeConfig ? { includes: includeConfig } : {}),
  }
  const rules = lintRules(options.lint?.severities)
  try {
    lintDiagnostics = lint(source, rules ? { ...lintOptions, rules: rules as LintOptions['rules'] } : lintOptions)
  } catch (error) {
    if (!(error instanceof CarveOptionError)) throw error
    // A severity naming no 0.2 rule must not cost the other findings.
    if (rules) {
      try {
        lintDiagnostics = lint(source, lintOptions)
      } catch (retry) {
        if (!(retry instanceof CarveOptionError)) throw retry
      }
    }
  }
  // Include findings are published from the include pass below, anchored on the root.
  const included = includeConfig && lintDiagnostics.some((entry) => entry.file !== undefined)
    ? safeParse(source, includeConfig)
    : undefined
  for (const entry of lintDiagnostics) {
    if (entry.code.startsWith('include-')) continue
    const site = entry.file === undefined || !included ? undefined : includeSiteOf(included, entry.path)
    const child = entry.file === undefined ? undefined : includes.documents.find((document) => document.id === entry.file)
    const childName = entry.file === undefined ? undefined : safeChildName(entry.file, options.includes, paths)
    const range = entry.range && entry.file === undefined
      ? byteRange(source, entry.range.startOffset, entry.range.endOffset)
      : site ?? rangeAt(source, 0, 0)
    const diagnostic: Diagnostic = {
      severity: ENGINE_SEVERITY[entry.severity] ?? DiagnosticSeverity.Warning,
      range,
      source: 'carve',
      code: entry.code,
      message: childName ? `${entry.message} (in ${childName}${childLineSuffix(child?.source, entry.range?.startOffset)})` : entry.message,
    }
    if (child?.watch !== undefined && entry.range) diagnostic.relatedInformation = [{
      location: { uri: paths.toUri(child.watch), range: byteRange(child.source, entry.range.startOffset, entry.range.endOffset) },
      message: entry.message,
    }]
    const related = entry.file === undefined && options.uri ? firstDuplicateDeclaration(source, entry.code, entry.message, range.start.line) : null
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
  for (const warning of includes.warnings) {
    const child = childLocation(warning, includes.documents, paths)
    diagnostics.push({
      severity: DiagnosticSeverity.Warning,
      range: {
        start: positionAt(norm, codepointOffsetToIndex(norm, warning.start)),
        end: positionAt(norm, codepointOffsetToIndex(norm, warning.end)),
      },
      source: 'carve',
      // A refusal publishes its own code, so an author whose include was
      // DENIED is not sent looking for a typo. The warning's rule id is left
      // alone; `include-denial.ts` holds the mapping and why it is safe.
      code: (warning.denial && includeDenialCode(warning.denial)) ?? warning.rule,
      // `warning.detail` is deliberately not folded in: §19 I7 keeps a thrown
      // resolver's own error out of author-visible text, and it routinely
      // carries absolute host paths. The attributed child is named relative to
      // the include root for the same reason - never as an absolute path.
      message: attributeToChild(warning.message, warning.file, options.includes, paths),
      // The child is NAMED in the message for a client that renders none of
      // this, and LOCATED here for one that does. Both, because dropping the
      // prose regresses every client without related information, and dropping
      // the location leaves the author editing the parent to fix the child.
      ...(child ? { relatedInformation: [{ location: child, message: warning.message }] } : {}),
    })
  }

  return {
    diagnostics: configuredDiagnostics(diagnostics, options.lint?.severities),
    symbols: doc ? documentSymbols(doc, source) : tolerantHeadingSymbols(source),
    dependencies: includes.dependencies,
    includedSymbols: includedSymbols(includes.documents, options.includedParseCache, paths),
  }
}

// `LintWarning.severity`; a finding without one is a warning.
const ENGINE_SEVERITY: Readonly<Record<string, DiagnosticSeverity>> = { hint: DiagnosticSeverity.Hint, warning: DiagnosticSeverity.Warning, error: DiagnosticSeverity.Error }

function byteRange(source: string, start: number, end: number): Range {
  const from = astOffsetToIndex(source, start)
  const to = Math.max(from + 1, astOffsetToIndex(source, end))
  return { start: positionAt(source, from), end: positionAt(source, Math.min(to, Math.max(from, source.length))) }
}

function safeParse(source: string, includes: IncludeConfig): Document | undefined {
  try {
    return parse(source, { includes })
  } catch {
    return undefined
  }
}

/** The root range of the outermost include node on the way to `pointer`. */
function includeSiteOf(document: Document, pointer: string | undefined): Range | undefined {
  if (!pointer) return undefined
  let node: unknown = document
  for (const step of pointer.split('/').slice(1)) {
    if (!node || typeof node !== 'object') return undefined
    node = (node as Record<string, unknown>)[step.replace(/~1/g, '/').replace(/~0/g, '~')]
    const typed = node as { type?: string; pos?: { startOffset: number; endOffset: number } } | undefined
    if (typed?.type === 'include' && typed.pos) {
      const source = sourceOfLastAnalysis
      if (source === undefined) return undefined
      const range = byteRange(source, typed.pos.startOffset, typed.pos.endOffset)
      // The directive's own line, below any attribute lines its span starts at (C2-A-148).
      const line = ownStartLine({ startLine: range.start.line + 1, endLine: range.end.line + 1 }, source.split(/\r\n?|\n/))
      return line === range.start.line ? range : { start: { line, character: range.start.character }, end: range.end }
    }
  }
  return undefined
}
let sourceOfLastAnalysis: string | undefined

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
  const headingKey = rule === 'duplicate-id' ? /authored id "([^"]+)"/.exec(message)?.[1] : undefined
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
    if (!match || match[1] !== key) continue
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
  paths: IncludePaths,
): SymbolInformation[] {
  const symbols: SymbolInformation[] = []
  for (const child of documents) {
    let document = child.version === undefined ? undefined : cache?.get(child.id, child.version)
    if (!document) {
      try {
        document = parse(child.source)
      } catch {
        continue
      }
      if (child.version !== undefined) cache?.set(child.id, child.version, document)
    }
    const uri = paths.toUri(child.id)
    const lines = sourceLines(child.source)
    for (const entry of walkOutline(document)) {
      // An INCLUDED file contributes its headings, flat. A composite figure is
      // a landmark inside its own file rather than a navigable entry in
      // another one, so it stays out of this list.
      if (entry.type !== 'heading') continue
      const symbol = headingSymbol(entry, lines)
      symbols.push({
        name: symbol.name,
        kind: symbol.kind,
        location: { uri, range: symbol.range },
        containerName: paths.basename(child.id),
      })
    }
  }
  return symbols
}

/**
 * Where an include warning actually sits, as a location a client can open.
 *
 * Three things have to hold, and each absence is a reason to report no location
 * rather than invent one: a child-local span, a child whose source this pass
 * actually read, and a real filesystem path for it.
 *
 * That last one is the resolver's `watch`, not a shape test on the id. An id is
 * whatever the resolver chose - a virtual-filesystem resolver can hand back
 * `/virtual/child.crv`, which `path.isAbsolute` accepts and which no editor can
 * open. `watch` is only set by a resolver that read the target off a disk.
 */
function childLocation(
  warning: IncludeWarning,
  documents: IncludeResolution['documents'],
  paths: IncludePaths,
): { uri: string; range: Range } | undefined {
  const { file, within } = warning
  if (file === undefined || within === undefined) return undefined
  const child = documents.find((document) => document.id === file)
  if (child?.watch === undefined) return undefined
  return {
    uri: paths.toUri(child.watch),
    range: {
      start: positionAt(child.source, codepointOffsetToIndex(child.source, within.start)),
      end: positionAt(child.source, codepointOffsetToIndex(child.source, within.end)),
    },
  }
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
  paths: IncludePaths,
): string {
  if (file === undefined || file === includes?.sourcePath) return message
  const root = includes?.includeRoot
  return `${message} (in ${root === undefined ? file : paths.relativeToRoot(file, root)})`
}

function safeChildName(file: string, includes: IncludeOptions | undefined, paths: IncludePaths): string {
  const relative = includes?.includeRoot === undefined ? file : paths.relativeToRoot(file, includes.includeRoot)
  return /^(?:[a-z]:[\\/]|[\\/])/i.test(relative) ? paths.basename(relative) : relative
}

function documentSymbols(doc: Document, source: string): DocumentSymbol[] {
  const lines = sourceLines(source)
  const stack: Array<{ level: number; symbol: DocumentSymbol }> = []
  const roots: DocumentSymbol[] = []

  const place = (symbol: DocumentSymbol): void => {
    // A section that ended (its container closed) cannot hold what follows.
    while (stack.length && stack[stack.length - 1]!.symbol.range.end.line < symbol.range.start.line) stack.pop()
    const parent = stack[stack.length - 1]
    if (parent) {
      parent.symbol.children ??= []
      parent.symbol.children.push(symbol)
    } else {
      roots.push(symbol)
    }
  }

  const sections = new Map(headingSections(doc, lines).map((section) => [section.heading, section.endLine]))
  for (const entry of walkOutline(doc)) {
    if (entry.type === 'figure_group') {
      // A composite figure is a structural landmark: one figure holding
      // ordered panels (PART 9 §4c). It takes NO level, so it never pops the
      // heading stack - it hangs under the section it appears in, the way a
      // heading's own children do.
      place(figureGroupSymbol(entry, lines))
      continue
    }
    while (stack.length && stack[stack.length - 1]!.level >= entry.level) {
      stack.pop()
    }
    const symbol = headingSymbol(entry, lines, sections.get(entry))
    place(symbol)
    stack.push({ level: entry.level, symbol })
  }

  return roots
}

type OutlineEntry = Heading | Extract<BlockNode, { type: 'figure_group' }>

/**
 * The outline's entries in source order: headings, and composite figures, at
 * any depth (list items, definitions and footnote bodies included).
 *
 * A group is worth an entry where a plain figure is not, because it is a
 * CONTAINER an author folds, navigates and loses their place inside - the same
 * reason it folds. Its panels come with it, so the outline says how many there
 * are without scrolling the fence.
 */
function walkOutline(doc: Document): OutlineEntry[] {
  const entries: OutlineEntry[] = []
  walkNodes(doc.children, (node) => {
    if (node.type === 'heading' || node.type === 'figure_group') entries.push(node as unknown as OutlineEntry)
    return node.type !== 'heading' && node.type !== 'paragraph'
  })
  return entries.sort((a, b) => (a.pos?.startLine ?? 0) - (b.pos?.startLine ?? 0))
}

/** A group's panels are its direct `figure` and `table` children (§4c). */
function isPanel(node: BlockNode): boolean {
  return isFigure(node) || node.type === 'table'
}

function figureGroupSymbol(group: Extract<BlockNode, { type: 'figure_group' }>, lines: readonly string[]): DocumentSymbol {
  const range = blockRange(group, lines)
  const panels = group.children.filter(isPanel)
  return {
    name: plainText(captionInlines(group.caption)) || 'Composite figure',
    detail: panels.length === 1 ? '1 panel' : `${panels.length} panels`,
    kind: SymbolKind.Struct,
    range,
    selectionRange: range,
    children: panels.map((panel, index) => panelSymbol(panel, index, lines)),
  }
}

/**
 * A panel is named by its own caption, and falls back to the LETTER a crossref
 * would use for it (§4c) - not to a number, which would read as a figure number
 * the panel does not have.
 */
function panelSymbol(panel: BlockNode, index: number, lines: readonly string[]): DocumentSymbol {
  const caption = (panel as { caption?: CaptionNode }).caption
  const range = blockRange(panel, lines)
  return {
    name: plainText(captionInlines(caption)) || `Panel ${panelLetter(index)}`,
    kind: panel.type === 'table' ? SymbolKind.Array : SymbolKind.Object,
    range,
    selectionRange: range,
    children: [],
  }
}

function blockRange(node: BlockNode, lines: readonly string[]): Range {
  if (!node.pos) {
    return { start: { line: 0, character: 0 }, end: { line: 0, character: 0 } }
  }
  return lineSpan(lines, node.pos.startLine - 1, node.pos.endLine - 1)
}

/** Whole lines `start` through `end`, 0-based and inclusive. */
function lineSpan(lines: readonly string[], start: number, end: number): Range {
  return {
    start: { line: start, character: 0 },
    end: { line: end, character: lines[end]?.length ?? 0 },
  }
}

/** `range` spans the section when `sectionEnd` is known; `selectionRange` is the heading's own lines. */
function headingSymbol(heading: Heading, lines: readonly string[], sectionEnd?: number): DocumentSymbol {
  const selectionRange = heading.pos
    ? lineSpan(lines, ownStartLine(heading.pos, lines), heading.pos.endLine - 1)
    : { start: { line: 0, character: 0 }, end: { line: 0, character: 0 } }
  const range = heading.pos && sectionEnd !== undefined && sectionEnd >= selectionRange.end.line
    ? lineSpan(lines, selectionRange.start.line, sectionEnd)
    : selectionRange
  return {
    name: plainText(heading.children) || `Heading ${heading.level}`,
    kind: SymbolKind.String,
    range,
    selectionRange,
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
    else if (node.type === 'literal_inline') out += node.value
    // A caption's resolved number. Without it a composite figure appeared in
    // the outline as "Figure : Group caption", with the gap where the number
    // the reader is looking for should be.
    else if (node.type === 'caption_number') out += String(node.n)
    else if (node.type === 'symbol') out += `:${node.name}:`
    else if (node.type === 'mention') out += `@${node.target}`
    else if (node.type === 'tag') out += `#${node.name}`
    else out += smartPunctuationText(node)
  }
  return out.trim()
}

let locatedSource: string | undefined
let lineStarts: number[] = []

/** An offset to an LSP position; any line ending counts as one break. */
function positionAt(source: string, offset: number) {
  if (source !== locatedSource) {
    locatedSource = source
    lineStarts = [0]
    for (const match of source.matchAll(/\r\n?|\n/g)) lineStarts.push(match.index + match[0].length)
  }
  let low = 0
  let high = lineStarts.length - 1
  while (low < high) {
    const middle = (low + high + 1) >> 1
    if (lineStarts[middle]! <= offset) low = middle
    else high = middle - 1
  }
  return { line: low, character: offset - lineStarts[low]! }
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

/**
 * 0.2 lint switches rules by id and keeps opt-in rules off by default. A
 * configured severity turns its rule on, and `off` turns it off.
 */
function lintRules(severities: NonNullable<AnalyzeOptions['lint']>['severities']): Record<string, 'on' | 'off'> | undefined {
  if (!severities) return undefined
  const entries = Object.entries(severities)
  if (entries.length === 0) return undefined
  return Object.fromEntries(entries.map(([id, severity]) => [id, severity === 'off' ? 'off' : 'on']))
}

/** `:line` of a byte offset in an included file, 1-based, when the file was read. */
function childLineSuffix(source: string | undefined, byteOffset: number | undefined): string {
  if (source === undefined || byteOffset === undefined) return ''
  return `:${byteRange(source, byteOffset, byteOffset).start.line + 1}`
}
