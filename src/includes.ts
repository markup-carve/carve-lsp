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
 * Two of the six §19 MUSTs are properties of the graph rather than of a single
 * path, so they are enforced here:
 *
 * - MUST bound recursion depth
 * - MUST bound total expanded byte size
 *
 * The other four live in {@link ./include-path.js}.
 */
import { findDirectives } from './include-directive.js'
import type { IncludeResolver } from './include-path.js'

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
   * Failure class, when one exists. Kept OUT of `message` on purpose: §19 I7
   * requires a processor-generated message naming the failure class rather
   * than a resolver's own error, which routinely embeds absolute filesystem
   * paths. Tools that want it (a log sink, a test) read it here; the published
   * diagnostic does not print it.
   */
  detail?: string
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
  /** Successfully read child documents, de-duplicated by canonical id. */
  documents: Array<{ id: string; source: string; version?: string }>
}

const MIN_BUDGET = 1024 * 1024
const DEFAULT_MAX_DEPTH = 16

interface Anchor {
  start: number
  end: number
}

interface State {
  resolver: IncludeResolver
  sourcePath: string | undefined
  maxDepth: number
  maxBytes: number
  usedBytes: number
  warnings: IncludeWarning[]
  dependencies: Map<string, IncludeDependency>
  documents: Map<string, { source: string; version?: string }>
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

function locate(state: State, offset: number): { line: number; column: number } {
  let low = 0
  let high = state.lineStarts.length - 1
  while (low < high) {
    const mid = (low + high + 1) >> 1
    if (state.lineStarts[mid]! <= offset) low = mid
    else high = mid - 1
  }
  return { line: low + 1, column: offset - state.lineStarts[low]! + 1 }
}

function warn(
  state: State,
  rule: string,
  message: string,
  at: Anchor,
  file: string | undefined,
  detail?: string,
): void {
  const warning: IncludeWarning = {
    ...locate(state, at.start),
    rule,
    message,
    start: at.start,
    end: at.end,
  }
  if (file !== undefined) warning.file = file
  if (detail !== undefined) warning.detail = detail
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

function visit(
  state: State,
  text: string,
  file: string | undefined,
  stack: string[],
  depth: number,
  anchor: Anchor | null,
): void {
  const directives = findDirectives(text, (part, start, end) => {
    warn(
      state,
      'include-unknown-option',
      `Unknown include option "${part}".`,
      anchor ?? { start, end },
      file,
    )
  })

  for (const directive of directives) {
    // A nested warning is reported at the top-level directive that pulled the
    // chain in, because that is the only range valid in the document the
    // client has open. `file` says where it actually arose.
    const at = anchor ?? { start: directive.start, end: directive.end }

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

    // GUARD 5a (§19: MUST bound total expanded byte size). Once the budget is
    // gone, later directives are refused BEFORE the resolver is called, so an
    // exhausted budget also stops the reads. Without this a document with N
    // sibling directives still pays N reads after expansion had already
    // stopped.
    if (state.usedBytes >= state.maxBytes) {
      warn(
        state,
        'include-budget',
        `Include byte budget exceeded by "${directive.path}".`,
        at,
        file,
      )
      continue
    }

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
      warn(
        state,
        'include-unresolved',
        `Include "${directive.path}" could not be resolved.`,
        at,
        file,
        resolved.denial,
      )
      continue
    }

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
    if (state.usedBytes > state.maxBytes) {
      warn(
        state,
        'include-budget',
        `Include byte budget exceeded by "${directive.path}".`,
        at,
        file,
      )
      continue
    }

    if (!state.documents.has(resolved.id)) {
      state.documents.set(resolved.id, {
        source: resolved.source,
        ...(resolved.version === undefined ? {} : { version: resolved.version }),
      })
    }

    visit(state, resolved.source, resolved.id, [...stack, resolved.id], depth + 1, at)
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
