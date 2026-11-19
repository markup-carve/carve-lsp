/**
 * Include resolution for the language server (PART 9 §19), delegated to the
 * engine.
 *
 * The rules are `expandIncludes`': it merges each child into the parent and
 * reports every §19 degradation, including the six that are only decidable
 * once the merge has happened - a clamped heading level, a renamed heading id
 * or footnote label, block content at an inline position. This server used to
 * carry its own walk because the pinned engine had no include pass; it has one
 * now, so the walk is gone and there is one spelling of each rule again.
 *
 * What stays here is what a language server needs and the engine's contract
 * cannot carry:
 *
 * - the ROOT anchor for every warning. The engine reports a child's problem at
 *   the child's own offsets, which is right for a renderer and unusable as an
 *   LSP range: the client has the root open. The engine names the top-level
 *   directive on `includedBy`, so the anchor is a read rather than a
 *   reconstruction; each warning keeps that root span and gains
 *   {@link IncludeWarning.within} for the other end.
 * - the `watch` candidate and the refusal class, which the engine's resolver
 *   contract has no slot for.
 * - the child sources, which the outline and the seam location read back.
 *
 * The path-level security guards are untouched in {@link ./include-path.js}.
 * The resolver is still this server's, so what may be read at all is still
 * decided here.
 */
import type { IncludePaths } from './include-paths.js'
import {
  includeDependencies,
  parseWithDiagnostics,
  utf8Length,
  type Document,
  type EngineDiagnostic,
  type IncludeConfig,
  type IncludeResolver as V2IncludeResolver,
} from './engine.js'
import { astOffsetToIndex } from './position.js'
import { includeDenialMessage } from './include-denial.js'

import type { IncludeDenial, IncludeResolver } from './include-path.js'

/** Warning emitted by {@link resolveIncludes}. */
export interface IncludeWarning {
  /** 1-based line number in the ROOT document. */
  line: number
  /** 1-based column number in the ROOT document. */
  column: number
  /** Stable rule id, e.g. "include-cycle". */
  rule: string
  /** Human-readable explanation of the include degradation. */
  message: string
  /**
   * Raw text of a resolver that THREW. Kept OUT of `message` on purpose: §19 I7
   * requires a processor-generated message naming the failure class rather
   * than a resolver's own error, which routinely embeds absolute filesystem
   * paths. Tools that want it (a log sink, a test) read it here; the published
   * diagnostic does not print it. A resolver that REFUSED rather than threw
   * reports its class on {@link denial}, which is typed and safe to publish.
   */
  detail?: string
  /**
   * Resolver refusal class, when the failure came from a resolver that reports
   * one. Typed, unlike {@link detail}, which is overloaded with the raw text of
   * a resolver that THREW and must never reach an author. The published
   * diagnostic maps this to its code and wording; see
   * {@link ./include-denial.js}.
   */
  denial?: IncludeDenial
  /** 0-based start offset in the ROOT document, inclusive. */
  start: number
  /** 0-based end offset in the ROOT document, exclusive. */
  end: number
  /**
   * Identity of the file the warning arose in: the resolver's canonical id, or
   * the raw directive path when there is none. A directive that failed to
   * resolve is attributed to the document containing it, not to the target it
   * names; a warning raised while expanding a child is attributed to that child.
   */
  file?: string
  /**
   * Where the warning actually sits inside {@link file}: that file's own
   * offsets, and its own 1-based line and column.
   *
   * `start`/`end` above stay anchored to the ROOT document, because that is
   * the only range valid in the document the client has open. This is the
   * other half, for a host that can also open the child: a diagnostic that
   * points at the parent for a child's problem sends the author to edit the
   * wrong file, which is worse than reporting nothing.
   *
   * Absent for a warning raised in the root document, where `start`/`end`
   * already are that position.
   */
  within?: { line: number; column: number; start: number; end: number }
}

/**
 * One include target touched during resolution. Hosts key file watchers off
 * `id`, so unresolved targets are reported too: a watcher that followed only
 * successful reads would never notice a missing `{{ chapter-3.crv }}` being
 * created, and would stay stale in exactly the case includes are for.
 */
export interface IncludeDependency {
  id: string
  /** True when the resolver produced source text for this target. */
  resolved: boolean
  /** Absolute legal filesystem candidate a host can watch. */
  watch?: string
}

export interface IncludeOptions {
  /** How children are named for the client; the server passes the Node implementation. */
  paths?: IncludePaths
  /** Resolve an include path to source text. Absent means the pass is inert. */
  resolver?: IncludeResolver
  /** Identity of the root document, for warning attribution. */
  sourcePath?: string
  /**
   * Containment root the resolver was built with. Not used for resolution -
   * the resolver owns that - only so a host can render a child's identity
   * relative to the root instead of as an absolute path (§19 I7).
   */
  includeRoot?: string
  /** Maximum transitive include depth. Default 16. */
  maxDepth?: number
  /** Total byte budget across the walk. Default max(1 MiB, 8 x root bytes). */
  maxBytes?: number
  /**
   * Resolver calls allowed for one walk. Default 1000, the §19 RECOMMENDED
   * floor and the engine's own default.
   *
   * Bounds the WORK, which the byte budget does not: a target is resolved
   * before its size is known, and a target that fails to resolve is never
   * charged at all.
   */
  maxResolverCalls?: number
  /**
   * Warnings retained. Default 100, the engine's. One per distinct rule always
   * survives and {@link IncludeResolution.suppressedWarnings} reports the
   * remainder, so a document of a thousand refused directives costs a bounded
   * republish on every keystroke without hiding a failure class.
   */
  maxWarnings?: number
}

export interface IncludeResolution {
  warnings: IncludeWarning[]
  /** Warnings raised but not retained. Zero on every uncapped run. */
  suppressedWarnings: number
  /**
   * Every include target touched, nested children included, de-duplicated and
   * in first-encounter order. Empty when no resolver was supplied.
   */
  dependencies: IncludeDependency[]
  /** Bytes charged against the budget. */
  bytes: number
  /**
   * Successfully read child documents, de-duplicated by canonical id.
   *
   * `watch` is the resolver's own filesystem path for the child, present only
   * when the resolver has one. It is what separates a real file from an
   * identity that merely looks like a path: a virtual-filesystem resolver may
   * hand back `/virtual/child.crv`, and a host that turned that into a `file:`
   * URI would offer the author a location that does not exist.
   */
  documents: Array<{ id: string; source: string; version?: string; watch?: string }>
  /**
   * The document with every child merged in, as §19 defines it, or `undefined`
   * when the pass was inert or the root did not parse.
   *
   * Every node a child contributed carries that child's identity on `pos.file`
   * (§19 source mapping), and carries it AFTER the renames, clamps and section
   * selection the merge applied. That is what makes it the thing to navigate
   * through: a crossref in the parent names the id the merged document ended
   * up with, which is not always the id the child file spells.
   */
  expanded?: Document
}

/**
 * Offset of each line's first character, counted in the unit the installed
 * parser's offsets are in, so `locateIn` can be given one directly.
 *
 * Exported for the test that drives the branch the installed engine does not
 * take. A test that built its own table would agree with this one under either
 * unit and so could not see the branch at all.
 */
export function lineStarts(source: string): number[] {
  const perCharacter = true
  const starts = [0]
  let offset = 0
  for (const character of source) {
    offset += perCharacter ? 1 : character.length
    if (character === '\n') starts.push(offset)
  }
  return starts
}

function locateIn(starts: number[], offset: number): { line: number; column: number } {
  let low = 0
  let high = starts.length - 1
  while (low < high) {
    const mid = (low + high + 1) >> 1
    if (starts[mid]! <= offset) low = mid
    else high = mid - 1
  }
  return { line: low + 1, column: offset - starts[low]! + 1 }
}

/** What the adapter learns at the resolver seam and joins back afterwards. */
interface Seam {
  /** Watchable filesystem candidate, by the identity the engine reports. */
  watch: Map<string, string>
  /**
   * A refused request, keyed by the file the directive was written in and the
   * path it wrote: what a diagnostic and a dependency both carry. The same
   * spelling below two directories is two different refusals.
   */
  refused: Map<string, { id: string; denial?: IncludeDenial; detail?: string; callLimit?: boolean; budget?: boolean }>
  /** Child source as read, line endings normalized, by identity. */
  documents: Map<string, { source: string; version?: string; watch?: string }>
  /** UTF-8 bytes charged: every text the resolver returned, the one that overran the budget included. */
  bytes: number
  /** The budget was overrun; every later directive is refused without a read. */
  spent: boolean
}

const DEFAULT_MAX_RESOLVER_CALLS = 1000
const DEFAULT_MAX_WARNINGS = 100
const ENGINE_MAX_DEPTH = 16
// What the engine refuses as non-text (C2-N-011): a NUL or a lone surrogate. It is charged nothing.
const NON_TEXT = /\0|[\uD800-\uDBFF](?![\uDC00-\uDFFF])|(?<![\uD800-\uDBFF])[\uDC00-\uDFFF]/

/**
 * The server's contained resolver as the `includes` option of the 0.2 engine.
 * A refusal maps to the 0.2 error cause (C2-N-013); the denial class stays with
 * the server's own include pass. A config is spent by one engine call.
 */
export function v2IncludeConfig(options: IncludeOptions, seam?: Seam): IncludeConfig | undefined {
  const resolver = options.resolver
  if (!resolver) return undefined
  // The 0.2 option has no resolver-call bound, so the resolver enforces the server's own; a call past it reads as unreadable.
  const maxCalls = options.maxResolverCalls ?? DEFAULT_MAX_RESOLVER_CALLS
  let calls = 0
  // The engine names only the including file; the server's resolver wants the
  // chain, root first, to resolve a nested path against its actual parent.
  const parents = new Map<string, string | undefined>()
  const chain = (id: string | undefined): string[] => {
    const stack: string[] = []
    for (let at = id, guard = 0; at !== undefined && guard <= ENGINE_MAX_DEPTH; at = parents.get(at), guard += 1) stack.unshift(at)
    return options.sourcePath === undefined ? stack : [options.sourcePath, ...stack]
  }
  const v2: V2IncludeResolver = (request) => {
    const from = request.from === undefined || request.from === options.sourcePath ? undefined : request.from
    const key = refusalKey(from, request.path)
    const stack = chain(from)
    // The engine charges only texts it accepts (C2-N-065), so a document of many
    // over-budget directives would read every one; the server stops reading at
    // the first overrun.
    if (seam?.spent) {
      seam.refused.set(key, { id: request.path, budget: true })
      return { error: 'unreadable' }
    }
    calls += 1
    if (calls > maxCalls) {
      seam?.refused.set(key, { id: request.path, callLimit: true })
      return { error: 'unreadable' }
    }
    let result
    try {
      result = resolver(request.path, {
        stack,
        depth: stack.length - (options.sourcePath === undefined ? 0 : 1),
        ...(options.sourcePath !== undefined ? { sourcePath: options.sourcePath } : {}),
      })
    } catch (error) {
      seam?.refused.set(key, { id: request.path, detail: error instanceof Error ? error.message : String(error) })
      return { error: 'unreadable' }
    }
    if (!result.ok) {
      // A target that did not resolve is named by where it WOULD appear, so two
      // files below different directories that both name `missing.crv` stay
      // distinct watchers (§19 I11).
      const id = result.watch ?? result.id
      seam?.refused.set(key, { id, denial: result.denial })
      if (result.watch !== undefined) seam?.watch.set(id, result.watch)
      const outside = result.denial === 'outside-root' || result.denial === 'absolute-denied' || result.denial === 'remote-not-allowed'
      return { error: outside ? 'outside_root' : result.denial === 'not-a-file' ? 'unreadable' : 'not_found' }
    }
    // A LONE carriage return is a line break to a client and to nothing else
    // here; substituting it is one code unit for one, so the byte budget still
    // bounds the size of the file that was read.
    const text = result.source.replace(/\r(?!\n)/g, '\n')
    if (!parents.has(result.id) && result.id !== options.sourcePath) parents.set(result.id, from)
    if (seam) {
      if (!NON_TEXT.test(text)) seam.bytes += utf8Length(text)
      if (options.maxBytes !== undefined && seam.bytes > options.maxBytes) seam.spent = true
      if (result.watch !== undefined) seam.watch.set(result.id, result.watch)
      if (!seam.documents.has(result.id)) {
        seam.documents.set(result.id, {
          source: text,
          ...(result.version === undefined ? {} : { version: result.version }),
          ...(result.watch === undefined ? {} : { watch: result.watch }),
        })
      }
    }
    return { text, id: result.id }
  }
  return {
    resolver: v2,
    ...(options.sourcePath !== undefined ? { file: options.sourcePath } : {}),
    ...(options.maxDepth !== undefined ? { depth: Math.min(options.maxDepth, ENGINE_MAX_DEPTH) } : {}),
    ...(options.maxBytes !== undefined ? { bytes: options.maxBytes } : {}),
  }
}

/**
 * Walk the include graph rooted at `source`.
 *
 * With no `resolver` the pass is INERT: no directive is recognized as
 * actionable, nothing is read, and neither a warning nor a dependency is
 * produced. That is how §19's "opt-in, off for untrusted input" is enforced at
 * this layer - the capability does not exist until a host hands over a
 * resolver, so no caller can reach the filesystem by forgetting a flag.
 */
export function resolveIncludes(source: string, options: IncludeOptions = {}): IncludeResolution {
  const inert: IncludeResolution = {
    warnings: [],
    suppressedWarnings: 0,
    dependencies: [],
    bytes: 0,
    documents: [],
  }
  if (!options.resolver) return inert

  const normalized = source.replace(/\r\n?/g, '\n')
  const seam: Seam = { watch: new Map(), refused: new Map(), documents: new Map(), bytes: 0, spent: false }
  let parsed
  try {
    parsed = parseWithDiagnostics(normalized, { positions: true, includes: v2IncludeConfig(options, seam)! })
  } catch {
    // A document that does not parse has no directive sites to expand. The
    // parse error itself is already published by the caller.
    return inert
  }
  const tree = parsed.document

  // A target is recorded at the RESOLVER seam, before the engine decides
  // whether it becomes part of the document (a cycle, a spent budget, a
  // missing section refuse it after the read). C2-N-019 stamps every node of a
  // merged child with its file, so the stamps are the children that survived.
  const merged = mergedFiles(tree)

  const starts = lineStarts(normalized)
  const all: IncludeWarning[] = []
  for (const entry of parsed.diagnostics) {
    if (entry.channel !== 'parse' || !entry.code.startsWith('include-') || entry.range === undefined) continue
    all.push(toWarning(entry, tree, normalized, starts, seam, options))
  }
  const { kept, suppressed } = capWarnings(all, options.maxWarnings ?? DEFAULT_MAX_WARNINGS)

  const dependencies: IncludeDependency[] = []
  const seen = new Set<string>()
  for (const dependency of includeDependencies(tree)) {
    const refusal = dependency.read ? undefined : seam.refused.get(refusalKey(dependency.from, dependency.path))
    const id = dependency.file ?? refusal?.id ?? dependency.path
    if (seen.has(id)) continue
    seen.add(id)
    const watch = seam.watch.get(id)
    dependencies.push({ id, resolved: dependency.read, ...(watch === undefined ? {} : { watch }) })
  }

  return {
    warnings: kept,
    suppressedWarnings: suppressed,
    dependencies,
    bytes: seam.bytes,
    expanded: tree,
    documents: [...seam.documents]
      .filter(([id]) => merged.has(id))
      .map(([id, child]) => ({ id, ...child })),
  }
}

function toWarning(
  entry: EngineDiagnostic,
  tree: Document,
  root: string,
  starts: number[],
  seam: Seam,
  options: IncludeOptions,
): IncludeWarning {
  const range = entry.range!
  // A finding in a CHILD carries that child's offsets, which name nothing in
  // the open document. The outermost include node on its pointer is the
  // top-level directive, whose range is in the root.
  const top = entry.file === undefined ? undefined : outermostInclude(tree, entry.path)
  const span = top?.pos ?? range
  const start = codepoints(root, span.startOffset)
  const end = codepoints(root, span.endOffset)
  const written = /"([^"]+)"/.exec(entry.message)?.[1]
  const refusal = written === undefined ? undefined : seam.refused.get(refusalKey(entry.file, written))
  const warning: IncludeWarning = {
    ...locateIn(starts, start),
    rule: refusal?.callLimit ? 'include-call-limit' : refusal?.budget ? 'include-budget' : entry.code,
    message: refusal?.callLimit && written !== undefined
      ? `Include "${written}" was not expanded: the resolver call limit is spent.`
      : refusal?.budget && written !== undefined
        ? `Include "${written}" was not expanded: the include byte budget is spent.`
        : entry.message,
    start,
    end,
  }
  const file = entry.file ?? options.sourcePath
  if (file !== undefined) warning.file = file
  if (entry.file !== undefined) {
    const child = seam.documents.get(entry.file)?.source ?? ''
    const childStart = codepoints(child, range.startOffset)
    const childStarts = lineStarts(child)
    warning.within = { ...locateIn(childStarts, childStart), start: childStart, end: codepoints(child, range.endOffset) }
  }
  if (refusal?.detail !== undefined) warning.detail = refusal.detail
  if (refusal?.denial !== undefined) {
    warning.denial = refusal.denial
    // Telling an author whose include was DENIED to go looking for a typo is
    // the failure `include-denial.ts` exists for.
    warning.message = includeDenialMessage(refusal.denial, written!) ?? warning.message
  }
  return warning
}

/** At most `limit` warnings, keeping the first of each rule so no failure class is hidden. */
function capWarnings(all: IncludeWarning[], limit: number): { kept: IncludeWarning[]; suppressed: number } {
  if (all.length <= limit) return { kept: all, suppressed: 0 }
  const firsts = new Set<IncludeWarning>()
  const rules = new Set<string>()
  for (const warning of all) {
    if (rules.has(warning.rule)) continue
    rules.add(warning.rule)
    firsts.add(warning)
  }
  let room = Math.max(0, limit - firsts.size)
  const kept = all.filter((warning) => {
    if (firsts.has(warning)) return true
    if (room === 0) return false
    room -= 1
    return true
  })
  return { kept, suppressed: all.length - kept.length }
}

/** The include node nearest the document on the RFC 6901 pointer `path`. */
function outermostInclude(tree: Document, path: string | undefined): { pos?: { startOffset: number; endOffset: number } } | undefined {
  if (!path) return undefined
  let node: unknown = tree
  for (const step of path.split('/').slice(1)) {
    if (node === null || typeof node !== 'object') return undefined
    node = (node as Record<string, unknown>)[step.replace(/~1/g, '/').replace(/~0/g, '~')]
    if (node && typeof node === 'object' && (node as { type?: unknown }).type === 'include') {
      return node as { pos?: { startOffset: number; endOffset: number } }
    }
  }
  return undefined
}

/** A UTF-8 byte offset of `source` as a code point offset. */
function codepoints(source: string, byte: number): number {
  const index = astOffsetToIndex(source, byte)
  if (index > source.length) return [...source].length + (index - source.length)
  return [...source.slice(0, index)].length
}

/** Every file identity stamped on a node of the expanded document. */
function mergedFiles(doc: Document): Set<string> {
  const files = new Set<string>()
  const visit = (value: unknown): void => {
    if (Array.isArray(value)) {
      for (const item of value) visit(item)
      return
    }
    if (value === null || typeof value !== 'object') return
    const file = (value as { pos?: { file?: string } }).pos?.file
    if (file !== undefined) files.add(file)
    for (const [key, inner] of Object.entries(value)) {
      if (key !== 'pos') visit(inner)
    }
  }
  visit(doc.children)
  return files
}

/** Key a refusal by the file that wrote the directive and the path it wrote. */
function refusalKey(file: string | undefined, written: string): string {
  return `${file ?? ''}\u0000${written}`
}
