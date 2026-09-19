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
 *   LSP range: the client has the root open. Each warning keeps its root span
 *   and gains {@link IncludeWarning.within} for the other end.
 * - the `watch` candidate and the refusal class, which the engine's resolver
 *   contract has no slot for.
 * - the child sources, which the outline and the seam location read back.
 *
 * The path-level security guards are untouched in {@link ./include-path.js}.
 * The resolver is still this server's, so what may be read at all is still
 * decided here.
 */
import {
  expandIncludes,
  findDirectiveSites,
  parse,
  type DirectiveSite,
  type Document,
  type IncludeContext as EngineContext,
  type IncludeResolved as EngineResolved,
  type IncludeUnresolved as EngineUnresolved,
  type IncludeWarning as EngineWarning,
} from '@markup-carve/carve'
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
}

function lineStarts(source: string): number[] {
  const starts = [0]
  for (let i = 0; i < source.length; i += 1) {
    if (source[i] === '\n') starts.push(i + 1)
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
   * Refusal class, keyed by the file the directive was written in and the path
   * it wrote. That pair is what a warning carries - `file` plus the quoted
   * path in its message - and it is stable where the resolved identity is not:
   * a refusal has no canonical id to key on, and the same spelling below two
   * directories is two different refusals.
   */
  denial: Map<string, IncludeDenial>
  /** Child source as read, line endings normalized, by identity. */
  documents: Map<string, { source: string; version?: string; watch?: string }>
  /** Any child identity to the top-level child whose chain it belongs to. */
  chain: Map<string, string>
  /** Top-level child identity to the directive path the root wrote for it. */
  rootPath: Map<string, string>
}

/**
 * Root span for a warning the engine anchored somewhere else.
 *
 * A warning from the root document already carries root offsets, but over the
 * enclosing inline node rather than the token: the engine anchors on the `Text`
 * a directive starts in, which for `See {{ a.crv }} here.` is the whole
 * sentence. Narrowing to the one directive site inside that span restores the
 * token. Where two sites share a node the span stays as the engine drew it -
 * coarse, never wrong.
 *
 * A warning from a CHILD carries that child's offsets, which name nothing in
 * the open document. It anchors at the top-level directive that pulled the
 * chain in, and {@link IncludeWarning.within} keeps the real position.
 *
 * Where the root writes the same target more than once, the engine expands it
 * once per occurrence and raises the same warning each time, but it reports no
 * occurrence identity - only the file. The warnings are therefore dealt over
 * the matching directives in document order, so every occurrence carries a
 * diagnostic instead of the first one carrying all of them. Two cases stay
 * approximate for want of that identity: occurrences that degrade DIFFERENTLY
 * pair up by position rather than by cause, and a child reached under two
 * different top-level directives anchors both chains at the later one. Both
 * need the including site on the engine's warning (#224).
 */
function rootSpan(
  warning: EngineWarning,
  sites: DirectiveSite[],
  seam: Seam,
  sourcePath: string | undefined,
  dealt: Map<string, number>,
): { start: number; end: number } | undefined {
  if (warning.file === undefined || warning.file === sourcePath) {
    const inside = sites.filter((site) => site.start >= warning.start && site.end <= warning.end)
    const only = inside.length === 1 ? inside[0]! : undefined
    return only ? { start: only.start, end: only.end } : { start: warning.start, end: warning.end }
  }
  const top = seam.chain.get(warning.file) ?? warning.file
  const written = seam.rootPath.get(top)
  if (written === undefined) return undefined
  const matching = sites.filter((site) => site.directive.path === written)
  if (matching.length === 0) return undefined
  const turn = dealt.get(written) ?? 0
  dealt.set(written, turn + 1)
  const site = matching[turn % matching.length]!
  return { start: site.start, end: site.end }
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
  const resolver = options.resolver
  if (!resolver) return inert

  const normalized = source.replace(/\r\n?/g, '\n')
  const seam: Seam = {
    watch: new Map(),
    denial: new Map(),
    documents: new Map(),
    chain: new Map(),
    rootPath: new Map(),
  }

  const link = (id: string, ctx: EngineContext, written: string): void => {
    if (ctx.depth === 0) {
      seam.chain.set(id, id)
      if (!seam.rootPath.has(id)) seam.rootPath.set(id, written)
      return
    }
    const parent = ctx.stack[ctx.stack.length - 1]
    seam.chain.set(id, (parent !== undefined ? seam.chain.get(parent) : undefined) ?? id)
  }

  const resolve = (
    written: string,
    ctx: EngineContext,
  ): EngineResolved | EngineUnresolved | null => {
    const result = resolver(written, {
      stack: [...ctx.stack],
      depth: ctx.depth,
      ...(options.sourcePath !== undefined ? { sourcePath: options.sourcePath } : {}),
    })
    if (!result.ok) {
      // §19 I11: a target that did not resolve is named by where it WOULD
      // appear, so two files below different directories that both name
      // `missing.crv` stay distinct. The resolver reports the raw spelling as
      // its id for a miss, and de-duplicating on that would collapse them into
      // one watcher - which is exactly the case includes exist for, since
      // creating either file has to invalidate.
      const id = result.watch ?? result.id
      link(id, ctx, written)
      seam.denial.set(refusalKey(ctx.stack[ctx.stack.length - 1], written), result.denial)
      if (result.watch !== undefined) seam.watch.set(id, result.watch)
      return { source: null, id }
    }
    link(result.id, ctx, written)
    if (result.watch !== undefined) seam.watch.set(result.id, result.watch)
    // A LONE carriage return is a line break to a client, to the engine's line
    // counting and to nothing else here: `positionAt` scans for `\n`, so a
    // child written with classic-Mac endings would place every warning in it on
    // line 1. Substituting it is one code unit for one, so the UTF-8 length the
    // engine charges against the byte budget stays the length of the file that
    // was read - which collapsing `\r\n` as well would not, and the budget
    // bounds a size rather than a shape. `\r\n` needs nothing: both the engine
    // and `positionAt` already count it as one break.
    const childSource = result.source.replace(/\r(?!\n)/g, '\n')
    if (!seam.documents.has(result.id)) {
      seam.documents.set(result.id, {
        source: childSource,
        ...(result.version === undefined ? {} : { version: result.version }),
        ...(result.watch === undefined ? {} : { watch: result.watch }),
      })
    }
    return { source: childSource, id: result.id }
  }

  let doc
  try {
    doc = parse(normalized, { positions: true })
  } catch {
    // A document that does not parse has no directive sites to expand. The
    // parse error itself is already published by the caller.
    return inert
  }
  const sites = findDirectiveSites(doc)
  const result = expandIncludes(doc, normalized, {
    resolve,
    ...(options.sourcePath === undefined ? {} : { sourcePath: options.sourcePath }),
    ...(options.maxDepth === undefined ? {} : { maxDepth: options.maxDepth }),
    ...(options.maxBytes === undefined ? {} : { maxBytes: options.maxBytes }),
    ...(options.maxResolverCalls === undefined ? {} : { maxResolverCalls: options.maxResolverCalls }),
    ...(options.maxWarnings === undefined ? {} : { maxWarnings: options.maxWarnings }),
  })

  // A target is recorded at the RESOLVER seam, which is before the engine has
  // decided whether what came back becomes part of the document: a target is
  // read and only then refused for a cycle, a spent budget, a line range past
  // the end, a section it does not declare, or content that is not text. Those
  // targets must not reach the outline or a seam location as if their content
  // were in the document.
  //
  // The expanded AST is the signal. §19 source mapping stamps every node of a
  // merged child with the file it came from, so the set of stamps IS the set
  // of children whose content survived - which no dependency flag can say,
  // since a dependency is resolved as soon as it is read.
  const merged = mergedFiles(result.doc)

  const starts = lineStarts(normalized)
  const dealt = new Map<string, number>()
  const warnings: IncludeWarning[] = []
  for (const warning of result.warnings) {
    const span = rootSpan(warning, sites, seam, options.sourcePath, dealt)
    if (span === undefined) continue
    const inChild = warning.file !== undefined && warning.file !== options.sourcePath
    const mapped: IncludeWarning = {
      ...locateIn(starts, span.start),
      rule: warning.rule,
      message: warning.message,
      start: span.start,
      end: span.end,
    }
    if (warning.file !== undefined) mapped.file = warning.file
    if (inChild) {
      mapped.within = {
        line: warning.line,
        column: warning.column,
        start: warning.start,
        end: warning.end,
      }
    }
    if (warning.detail !== undefined) mapped.detail = warning.detail
    // The engine reports every refusal as `include-unresolved`, because its
    // resolver contract cannot spell anything else. The class the server's own
    // resolver computed is joined back here, by the identity the engine used.
    if (warning.rule === 'include-unresolved') {
      const written = /"([^"]+)"/.exec(warning.message)?.[1]
      const denial =
        written === undefined ? undefined : seam.denial.get(refusalKey(warning.file, written))
      if (denial !== undefined) {
        mapped.denial = denial
        // The engine spells every refusal "could not be resolved", because its
        // resolver contract cannot tell a refusal from a miss. This server's
        // resolver can, and telling an author whose include was DENIED to go
        // looking for a typo is the failure `include-denial.ts` exists for.
        mapped.message = includeDenialMessage(denial, written!) ?? warning.message
      }
    }
    warnings.push(mapped)
  }

  const dependencies = result.dependencies.map((dependency) => {
    const watch = seam.watch.get(dependency.id)
    return {
      id: dependency.id,
      resolved: dependency.resolved,
      ...(watch === undefined ? {} : { watch }),
    }
  })

  return {
    warnings,
    suppressedWarnings: result.suppressedWarnings,
    dependencies,
    bytes: result.chargedBytes,
    documents: [...seam.documents]
      .filter(([id]) => merged.has(id))
      .map(([id, child]) => ({ id, ...child })),
  }
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
  if (doc.footnoteDefs) visit(Object.values(doc.footnoteDefs))
  return files
}

/** Key a refusal by the file that wrote the directive and the path it wrote. */
function refusalKey(file: string | undefined, written: string): string {
  return `${file ?? ''}\u0000${written}`
}
