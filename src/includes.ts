/**
 * Processor-level include resolution for the language server (PART 9 §19).
 *
 * This walks the include graph and reports what it found; it does NOT expand
 * anything into the document. The server publishes diagnostics, tracks
 * dependencies and navigates - none of which needs merged text - and the
 * merge itself (heading shifts, section selection, id and footnote renaming)
 * is engine work that carve-js and carve-php own. Resolution lives here
 * because §19 makes includes processor-level and the pinned engine has no
 * include pass at all.
 *
 * Four of the §19 MUSTs are properties of the graph rather than of a single
 * path, so they are enforced here:
 *
 * - MUST bound recursion depth
 * - MUST bound total expanded byte size
 * - MUST bound resolver invocations per render
 * - MUST make refusal terminal: once a whole-render total is spent, every
 *   later directive degrades WITHOUT being resolved
 *
 * The path-level ones live in {@link ./include-path.js}.
 *
 * The byte budget does not subsume the resolver-call bound, and cannot: an
 * unresolved target charges zero bytes, so a document of directives naming
 * files that do not exist resolves every one of them with the budget
 * untouched. Measured on this walk before the bound existed, 10,000 such
 * directives cost 10,000 filesystem resolutions on a pass the server re-runs
 * as the author types.
 *
 * The SELECTION checks - `#section` and the line range - live here too. They
 * are not MUSTs, but they are decidable from the child's own source without
 * merging anything, so a directive that names a section the child does not
 * have is a real error this server can report rather than a silent no-op.
 */
import { findDirectives } from './include-directive.js'
import { lineCount, sections } from './include-selection.js'
import { includeDenialMessage } from './include-denial.js'
import type { IncludeDenial, IncludeResolver } from './include-path.js'

/** Warning emitted by {@link resolveIncludes}. Shape mirrors the engine's. */
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
   * names; a warning raised while walking a child is attributed to that child.
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
}

export interface IncludeResolution {
  warnings: IncludeWarning[]
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

const MIN_BUDGET = 1024 * 1024
const DEFAULT_MAX_DEPTH = 16
const DEFAULT_MAX_RESOLVER_CALLS = 1000

interface Anchor {
  /** 0-based start offset in the ROOT document, inclusive. */
  start: number
  /** 0-based end offset in the ROOT document, exclusive. */
  end: number
  /**
   * The same directive located in the file it is actually written in, when
   * that is not the root. Carried on the anchor rather than as a parameter of
   * {@link warn}, so every warning gets it without a call site opting in - the
   * sites that would be forgotten are the nested ones this exists for.
   */
  within?: { line: number; column: number; start: number; end: number }
}

interface State {
  resolver: IncludeResolver
  sourcePath: string | undefined
  maxDepth: number
  maxBytes: number
  usedBytes: number
  maxResolverCalls: number
  resolverCalls: number
  /**
   * Rule of the first whole-walk total to refuse - the byte budget or the
   * resolver-call bound - or undefined while both have room. Both only ever
   * grow, so once either is spent no later directive can succeed; §19's
   * "refusal is terminal" requires the rest to degrade without being resolved
   * rather than be resolved and then refused.
   */
  spent?: 'include-budget' | 'include-call-limit'
  warnings: IncludeWarning[]
  dependencies: Map<string, IncludeDependency>
  documents: Map<string, { source: string; version?: string; watch?: string }>
  /** Offsets of every line start in the root document, for line/column. */
  lineStarts: number[]
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

function locate(state: State, offset: number): { line: number; column: number } {
  return locateIn(state.lineStarts, offset)
}

function warn(
  state: State,
  rule: string,
  message: string,
  at: Anchor,
  file: string | undefined,
  detail?: string,
  denial?: IncludeDenial,
): void {
  const warning: IncludeWarning = {
    ...locate(state, at.start),
    rule,
    message,
    start: at.start,
    end: at.end,
  }
  if (file !== undefined) warning.file = file
  if (at.within !== undefined) warning.within = at.within
  if (detail !== undefined) warning.detail = detail
  if (denial !== undefined) warning.denial = denial
  state.warnings.push(warning)
}

/**
 * Record an include target for host file watching. Deduplicated by id, first
 * encounter fixes the order, and a later successful read upgrades an entry
 * first seen unresolved.
 */
function note(state: State, id: string, resolved: boolean, watch?: string): void {
  // A canonical/watchable path is the dependency identity when available.
  // Two nested files can both name `missing.crv`; keying those by the raw
  // spelling would collapse distinct future files into one watcher.
  const key = watch ?? id
  const previous = state.dependencies.get(key)
  if (!previous || resolved) {
    state.dependencies.set(key, {
      id,
      resolved,
      ...(watch === undefined ? {} : { watch }),
    })
  } else if (previous.watch === undefined && watch !== undefined) {
    previous.watch = watch
  }
}

function spentMessage(rule: 'include-budget' | 'include-call-limit', path: string): string {
  return rule === 'include-call-limit'
    ? `Include resolver call limit exceeded for "${path}".`
    : `Include byte budget exceeded by "${path}".`
}

function visit(
  state: State,
  text: string,
  file: string | undefined,
  stack: string[],
  depth: number,
  anchor: Anchor | null,
): void {
  // A child is scanned against its OWN line table, so a span reported for it
  // is a real location in it rather than a root offset read against the wrong
  // text. The root reuses the table the state already built.
  const lines = anchor === null ? state.lineStarts : lineStarts(text)
  const within = (start: number, end: number): Anchor['within'] =>
    anchor === null ? undefined : { ...locateIn(lines, start), start, end }

  const directives = findDirectives(text, (part, start, end) => {
    warn(
      state,
      'include-unknown-option',
      `Unknown include option "${part}".`,
      anchor === null ? { start, end } : { ...anchor, within: within(start, end) },
      file,
    )
  })

  for (const directive of directives) {
    // A nested warning is reported at the top-level directive that pulled the
    // chain in, because that is the only range valid in the document the
    // client has open. `file` says where it actually arose, and `within` says
    // where in that file.
    const at: Anchor =
      anchor === null
        ? { start: directive.start, end: directive.end }
        : { ...anchor, within: within(directive.start, directive.end) }

    // A directive may select a section or a line range, never both. Purely
    // syntactic, so it is decided before anything is read - which also matches
    // the engine, where it is the first rejection in `resolveChild`.
    if (directive.section !== undefined && directive.lines !== undefined) {
      warn(
        state,
        'include-selection-conflict',
        `Include "${directive.path}" cannot use both a section and a line range.`,
        at,
        file,
      )
      continue
    }

    // GUARD 4 (§19: MUST bound recursion depth). Checked before the resolver
    // is called, so the over-deep target is never read - but it is still
    // reported as a dependency, since a host may want to watch it.
    if (depth >= state.maxDepth) {
      note(state, directive.path, false)
      warn(
        state,
        'include-depth',
        `Include depth limit of ${state.maxDepth} exceeded for "${directive.path}".`,
        at,
        file,
      )
      continue
    }

    // GUARD 5a (§19: refusal is terminal). A whole-walk total is already spent,
    // so this directive cannot expand whatever it resolves to. It is refused
    // WITHOUT being resolved - the target is never read - and reported
    // unresolved, because it genuinely was not.
    if (state.spent !== undefined) {
      note(state, directive.path, false)
      warn(state, state.spent, spentMessage(state.spent, directive.path), at, file)
      continue
    }

    // GUARD 6 (§19: MUST bound resolver invocations per render). Separate from
    // the byte budget because they bound different things: the budget bounds
    // expanded OUTPUT, this bounds the WORK. A directive past the bound "MUST
    // NOT be passed to the resolver", so it is checked before the call, and the
    // latch carries the refusal to every later directive.
    if (state.resolverCalls >= state.maxResolverCalls) {
      state.spent = 'include-call-limit'
      note(state, directive.path, false)
      warn(state, 'include-call-limit', spentMessage('include-call-limit', directive.path), at, file)
      continue
    }
    state.resolverCalls += 1

    let resolved
    try {
      resolved = state.resolver(directive.path, {
        stack: [...stack],
        depth,
        ...(state.sourcePath !== undefined ? { sourcePath: state.sourcePath } : {}),
      })
    } catch (error) {
      note(state, directive.path, false)
      warn(
        state,
        'include-unresolved',
        `Include "${directive.path}" could not be resolved.`,
        at,
        file,
        error instanceof Error ? error.message : String(error),
      )
      continue
    }

    if (!resolved.ok) {
      note(state, resolved.id, false, resolved.watch)
      // The RULE id stays `include-unresolved` for every refusal: four
      // include-conformance goldens pin it, and the engine's resolver returns a
      // bare `null` that could not carry anything else. The class rides along
      // typed, and the DIAGNOSTIC is where a refusal stops reading as a miss.
      warn(
        state,
        'include-unresolved',
        includeDenialMessage(resolved.denial, directive.path) ??
          `Include "${directive.path}" could not be resolved.`,
        at,
        file,
        undefined,
        resolved.denial,
      )
      continue
    }

    // §19 "Text-only": a binary or otherwise non-text target is not an include.
    // Checked BEFORE the target is noted resolved, charged or cached, so a
    // binary file named `.crv` degrades to the literal directive with a warning
    // instead of entering the walk as if it were source. `note` only ever
    // upgrades, so the order matters: noting it resolved first would make the
    // downgrade unreachable.
    if (resolved.source.includes('\u0000')) {
      note(state, resolved.id, false, resolved.watch)
      warn(
        state,
        'include-non-text',
        `Include "${directive.path}" did not resolve to text.`,
        at,
        file,
      )
      continue
    }

    // Line endings are normalized for the CHILD exactly as they are for the
    // root, and for the same reason: every offset this pass reports is read
    // back against this text. A lone `\r` is a line break to a client and not
    // to a `\n` scan, so a child written with CR endings would otherwise get a
    // location on line 1 for a directive further down. The BYTE budget is not
    // affected - it charges `resolved.bytes`, which is what was read off disk.
    const childSource = resolved.source.replace(/\r\n?/g, '\n')

    note(state, resolved.id, true, resolved.watch)

    if (stack.includes(resolved.id)) {
      warn(state, 'include-cycle', `Include cycle detected for "${directive.path}".`, at, file)
      continue
    }

    // GUARD 5 (§19: MUST bound total expanded byte size). The budget is
    // charged per OCCURRENCE, not per distinct file, so a document that
    // includes the same target N times pays N times - which is the shape an
    // include bomb actually takes.
    state.usedBytes += resolved.bytes
    // Latched as soon as the budget is fully consumed, not only when it is
    // overrun: a charge landing exactly on the limit leaves no room either, and
    // every later directive must then degrade without being resolved.
    if (state.usedBytes >= state.maxBytes) state.spent = 'include-budget'
    if (state.usedBytes > state.maxBytes) {
      warn(state, 'include-budget', spentMessage('include-budget', directive.path), at, file)
      continue
    }

    // The line range is measured on the child's RAW source, the same way the
    // engine measures it, so a range that starts past the end is reportable
    // without expanding anything.
    if (directive.lines !== undefined && directive.lines.start > lineCount(childSource)) {
      warn(
        state,
        'include-lines-out-of-range',
        `Include line range for "${directive.path}" starts past end of file.`,
        at,
        file,
      )
      continue
    }

    // A named section the child does not declare. Checked only when the child
    // pulls in nothing itself: the engine selects AFTER the child's own
    // includes are expanded, so a section that arrives through a grandchild is
    // legitimate, and this server does not expand. Staying quiet there is the
    // safe direction - a false "no such section" on a working document costs
    // more than a missing one.
    if (directive.section !== undefined && findDirectives(childSource).length === 0) {
      const ids = sections(childSource)
      if (!ids.some((section) => section.id === directive.section)) {
        warn(
          state,
          'include-section',
          `Include "${directive.path}" has no section "#${directive.section}".`,
          at,
          file,
        )
        continue
      }
    }

    if (!state.documents.has(resolved.id)) {
      state.documents.set(resolved.id, {
        source: childSource,
        ...(resolved.watch === undefined ? {} : { watch: resolved.watch }),
        ...(resolved.version === undefined ? {} : { version: resolved.version }),
      })
    }

    visit(state, childSource, resolved.id, [...stack, resolved.id], depth + 1, at)
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
  if (!options.resolver) return { warnings: [], dependencies: [], bytes: 0, documents: [] }

  const normalized = source.replace(/\r\n?/g, '\n')
  const state: State = {
    resolver: options.resolver,
    sourcePath: options.sourcePath,
    maxDepth: options.maxDepth ?? DEFAULT_MAX_DEPTH,
    maxBytes: options.maxBytes ?? Math.max(MIN_BUDGET, Buffer.byteLength(normalized, 'utf8') * 8),
    usedBytes: 0,
    maxResolverCalls: options.maxResolverCalls ?? DEFAULT_MAX_RESOLVER_CALLS,
    resolverCalls: 0,
    warnings: [],
    dependencies: new Map(),
    documents: new Map(),
    lineStarts: lineStarts(normalized),
  }

  const rootStack = options.sourcePath !== undefined ? [options.sourcePath] : []
  visit(state, normalized, options.sourcePath, rootStack, 0, null)

  return {
    warnings: state.warnings,
    dependencies: [...state.dependencies.values()],
    bytes: state.usedBytes,
    documents: [...state.documents].map(([id, child]) => ({ id, ...child })),
  }
}
