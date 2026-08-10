/**
 * The single place an include path becomes a file read.
 *
 * PART 9 §19 puts four MUSTs on this function, and they are here rather than
 * spread over the callers on purpose: a guard applied on one path and missed on
 * another is the defect this repository's siblings keep hitting. Nothing else
 * in this package joins, canonicalizes or opens an include target.
 *
 * - MUST resolve include paths only to files under the configured project root
 *   AFTER symlink resolution (rejecting `..`-traversal and absolute paths that
 *   escape the root)
 * - MUST NOT fetch remote URLs unless an allowlist is explicitly configured
 *
 * The remaining two MUSTs (recursion depth, total expanded byte size) are
 * properties of the include GRAPH rather than of one path, so they live in
 * {@link ./includes.js} where the walk is.
 */
import { closeSync, fstatSync, openSync, readSync, realpathSync } from 'node:fs'
import path from 'node:path'
import type { IncludeSourceCache } from './include-cache.js'

/**
 * Why a resolver refused a target. Reported on {@link IncludeWarning.detail},
 * never folded into the diagnostic message: §19 I7 requires a
 * processor-generated message naming the failure class, and the
 * include-conformance goldens (`i10-fs-*`) spell every containment denial as
 * the single rule `include-unresolved` so that a denial cannot be used to probe
 * host layout. The class is kept available for tooling and tests.
 */
export type IncludeDenial =
  | 'remote-not-allowed'
  | 'absolute-denied'
  | 'outside-root'
  | 'not-found'
  | 'not-a-file'

export interface IncludeContext {
  /** Identity of the including document, supplied by the host when known. */
  sourcePath?: string
  /**
   * Include chain, root first: the canonical id of each ancestor. Used for
   * relative resolution (a nested include resolves against its actual parent
   * directory) and for the cycle guard.
   */
  stack: string[]
  /** Zero-based include depth of the directive being resolved. */
  depth: number
}

export type IncludeResolved =
  | { ok: true; id: string; source: string; bytes: number; watch?: string; version?: string }
  | { ok: false; id: string; denial: IncludeDenial; watch?: string }

export type IncludeResolver = (includePath: string, ctx: IncludeContext) => IncludeResolved

export interface FileSystemResolverOptions {
  /** Allow absolute include paths, still subject to root containment. Default false. */
  allowAbsolute?: boolean
  /**
   * Hosts a remote include may name. Empty (the default) means no remote
   * include is permitted at all.
   *
   * Note that this server never fetches over the network under any setting:
   * an allowlisted host is still refused, because there is no fetcher. The
   * option exists so that "allowlist explicitly configured" is a real,
   * inspectable condition rather than an implicit one, and so a host that
   * later gains a fetcher has the gate already in place.
   */
  allowedRemoteHosts?: string[]
  /** Process-level child-source cache, consulted only after containment. */
  cache?: IncludeSourceCache
}

/** A scheme with an authority (`https://…`), or a protocol-relative `//host/…`. */
const REMOTE_RE = /^(?:[A-Za-z][A-Za-z0-9+.-]*:)?\/\//

function remoteHost(spec: string): string {
  const withScheme = spec.startsWith('//') ? `https:${spec}` : spec
  try {
    return new URL(withScheme).hostname
  } catch {
    return ''
  }
}

/**
 * Filesystem resolver with canonical root containment, for a workspace the
 * client reports as trusted.
 *
 * Canonicalize-then-contain: the candidate is resolved to its real path
 * (symlinks followed) and only then compared against the real root.
 *
 * Deliberately NOT a lexical ban on `..`, which is both too strict and too
 * weak. Too strict: `../shared/glossary.crv` from `chapters/ch1.crv` is a
 * normal book layout whose canonical target is inside the root, and the
 * conformance vector `i10-fs-dotdot-inside-root-allowed` requires it to
 * resolve. Too weak: a symlink inside the root pointing out of it, or an
 * absolute path, escapes without containing `..` at all
 * (`i10-fs-symlink-dir-escape-denied`). Canonical containment subsumes both.
 */
export function fileSystemResolver(
  includeRoot: string,
  opts: FileSystemResolverOptions = {},
): IncludeResolver {
  const rootReal = realpathSync(includeRoot)
  const allowedRemoteHosts = opts.allowedRemoteHosts ?? []

  const contains = (candidate: string): boolean => {
    const rel = path.relative(rootReal, candidate)
    if (rel === '') return true
    if (!rel || path.isAbsolute(rel)) return false
    // Segment-wise, so a directory legitimately named "..foo" is not read as
    // an escape the way a startsWith('..') prefix test would.
    return rel.split(path.sep)[0] !== '..'
  }

  const missingCandidate = (candidate: string): string | undefined => {
    let ancestor = path.dirname(candidate)
    const suffix = [path.basename(candidate)]
    while (ancestor !== path.dirname(ancestor)) {
      try {
        const ancestorReal = realpathSync(ancestor)
        const canonicalCandidate = path.join(ancestorReal, ...suffix)
        return contains(canonicalCandidate) ? canonicalCandidate : undefined
      } catch {
        suffix.unshift(path.basename(ancestor))
        ancestor = path.dirname(ancestor)
      }
    }
    return undefined
  }

  return (includePath, ctx) => {
    // GUARD 1 (§19: MUST NOT fetch remote URLs unless an allowlist is
    // explicitly configured). Checked before any path join, so a URL can never
    // be mistaken for a relative path and read off disk as `<root>/https:/…`.
    if (REMOTE_RE.test(includePath)) {
      const host = remoteHost(includePath)
      if (!allowedRemoteHosts.includes(host)) {
        return { ok: false, id: includePath, denial: 'remote-not-allowed' }
      }
      // Allowlisted, and still refused: this server has no fetcher. Reported
      // as a denial rather than silently, so the author sees why.
      return { ok: false, id: includePath, denial: 'remote-not-allowed' }
    }

    // GUARD 2 (§19: absolute paths). Denied outright by default; when the host
    // opts in, an absolute path still has to survive GUARD 3.
    if (!opts.allowAbsolute && path.isAbsolute(includePath)) {
      return { ok: false, id: includePath, denial: 'absolute-denied' }
    }

    // The stack carries the canonical path of each ancestor, so a nested
    // relative include resolves against its actual parent directory, not the
    // root.
    const parent = ctx.stack[ctx.stack.length - 1]
    const base = parent ? path.dirname(path.resolve(rootReal, parent)) : rootReal
    const joined = path.isAbsolute(includePath)
      ? includePath
      : path.resolve(base, includePath)

    let real: string
    try {
      // Symlink resolution happens HERE, before containment, which is what
      // makes a symlinked escape visible to GUARD 3 at all.
      real = realpathSync(joined)
    } catch {
      // A missing but lexically contained candidate is safe and useful to
      // watch: its later creation must revalidate the including document.
      const watch = missingCandidate(joined)
      return watch === undefined
        ? { ok: false, id: includePath, denial: 'outside-root' }
        : { ok: false, id: includePath, denial: 'not-found', watch }
    }

    // GUARD 3 (§19: only files under the configured project root AFTER symlink
    // resolution). Catches `..` that leaves the root, a symlink that points out
    // of it, and an absolute path outside it.
    if (!contains(real)) {
      return { ok: false, id: includePath, denial: 'outside-root' }
    }

    let fd: number
    try {
      fd = openSync(real, 'r')
    } catch {
      return { ok: false, id: includePath, denial: 'not-found' }
    }
    try {
      const stat = fstatSync(fd)
      // Regular files only. A FIFO or a character device would block the read
      // or stream without end, and neither is a document.
      if (!stat.isFile()) return { ok: false, id: real, denial: 'not-a-file' }
      const cached = opts.cache?.get(real, stat.mtimeMs, stat.size)
      const version = `${stat.mtimeMs}:${stat.size}`
      if (cached) return { ok: true, id: real, watch: real, version, ...cached }
      const buffer = Buffer.allocUnsafe(stat.size)
      let read = 0
      while (read < stat.size) {
        const n = readSync(fd, buffer, read, stat.size - read, read)
        if (n <= 0) break
        read += n
      }
      const value = {
        ok: true,
        id: real,
        watch: real,
        version,
        source: buffer.subarray(0, read).toString('utf8'),
        // Encoded bytes, not JavaScript characters, so the budget counts what
        // the include-bomb actually costs.
        bytes: read,
      } as const
      opts.cache?.set(real, stat.mtimeMs, stat.size, value)
      return value
    } finally {
      closeSync(fd)
    }
  }
}
