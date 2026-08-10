/**
 * Client-facing include settings and the decision of whether a document gets
 * include resolution at all (PART 9 §19: "MUST treat includes as opt-in (off
 * for untrusted input)").
 *
 * Kept out of `server.ts` so the opt-in decision is testable on its own. It is
 * the gate in front of a file-read capability, which is not something to leave
 * exercised only by hand.
 */
import { realpathSync } from 'node:fs'
import path, { dirname } from 'node:path'
import { fileURLToPath } from 'node:url'
import { fileSystemResolver } from './include-path.js'
import type { IncludeSourceCache } from './include-cache.js'
import type { IncludeOptions } from './includes.js'

export interface IncludeSettings {
  /**
   * `auto` (the default) means ON ONLY for a workspace the client has reported
   * as trusted. A client that says nothing about trust therefore gets includes
   * OFF: silence is not consent.
   */
  enabled: 'auto' | 'on' | 'off'
  /** Containment root override. Otherwise the workspace root, then the document's directory. */
  includeRoot?: string
  /** Allow absolute include paths, still subject to root containment. */
  allowAbsolute?: boolean
  /** Hosts a remote include may name. Empty means none; this server never fetches. */
  allowedRemoteHosts?: string[]
  maxDepth?: number
  maxBytes?: number
}

export const DEFAULT_INCLUDE_SETTINGS: IncludeSettings = { enabled: 'auto' }

/**
 * Read `carve.includes` out of `initializationOptions` or a
 * `workspace/didChangeConfiguration` payload. Anything unrecognized falls back
 * to the default rather than being trusted as given.
 */
export function readIncludeSettings(raw: unknown): IncludeSettings {
  const source = (raw as { carve?: { includes?: Record<string, unknown> } } | undefined)?.carve
    ?.includes
  if (!source || typeof source !== 'object') return DEFAULT_INCLUDE_SETTINGS
  const enabled = source['enabled']
  const settings: IncludeSettings = {
    enabled: enabled === 'on' || enabled === 'off' ? enabled : 'auto',
  }
  if (typeof source['includeRoot'] === 'string') settings.includeRoot = source['includeRoot']
  if (typeof source['allowAbsolute'] === 'boolean') settings.allowAbsolute = source['allowAbsolute']
  if (Array.isArray(source['allowedRemoteHosts'])) {
    settings.allowedRemoteHosts = source['allowedRemoteHosts'].filter(
      (host): host is string => typeof host === 'string',
    )
  }
  if (typeof source['maxDepth'] === 'number') settings.maxDepth = source['maxDepth']
  if (typeof source['maxBytes'] === 'number') settings.maxBytes = source['maxBytes']
  return settings
}

/** Client-reported workspace trust. Absent means untrusted. */
export function readWorkspaceTrusted(raw: unknown): boolean {
  return (raw as { workspaceTrusted?: unknown } | undefined)?.workspaceTrusted === true
}

export function fsPath(uri: string): string | undefined {
  if (!uri.startsWith('file:')) return undefined
  try {
    return fileURLToPath(uri)
  } catch {
    return undefined
  }
}

export interface IncludeGateInput {
  uri: string
  settings: IncludeSettings
  workspaceTrusted: boolean
  /**
   * Every workspace folder the client reported, in the order it reported them.
   * A multi-root session gets one root per folder, not the first folder for
   * everything: rooting a document from the second folder at the first would
   * reject its ordinary relative includes as escapes.
   */
  workspaceRoots?: string[]
  cache?: IncludeSourceCache
}

/** True when `candidate` is `root` or sits underneath it, segment-wise. */
function contains(root: string, candidate: string): boolean {
  const rel = path.relative(root, candidate)
  if (rel === '') return true
  if (!rel || path.isAbsolute(rel)) return false
  return rel.split(path.sep)[0] !== '..'
}

/**
 * The workspace folder this document belongs to: the deepest one containing
 * it. A document in no folder at all has no workspace root, and falls back to
 * its own directory rather than to somebody else's folder.
 */
function workspaceRootFor(documentPath: string, roots: string[] | undefined): string | undefined {
  let best: string | undefined
  for (const root of roots ?? []) {
    if (!contains(root, documentPath)) continue
    if (best === undefined || root.length > best.length) best = root
  }
  return best
}

/**
 * Build the include options for one document, or undefined to leave its
 * directives literal.
 *
 * The containment root is the explicit override, else the workspace root, else
 * the document's own directory for a file opened outside any workspace. It is
 * NEVER the process working directory: a language server is commonly spawned
 * from the user's home or from `/`, and rooting there would make containment
 * meaningless.
 */
export function includeOptionsFor(input: IncludeGateInput): IncludeOptions | undefined {
  // GUARD 0 (§19: MUST treat includes as opt-in, off for untrusted input).
  if (input.settings.enabled === 'off') return undefined
  if (input.settings.enabled === 'auto' && !input.workspaceTrusted) return undefined

  const documentPath = fsPath(input.uri)
  // A document with no filesystem identity (untitled:, a remote scheme) has no
  // directory to resolve against and gets no capability.
  if (documentPath === undefined) return undefined

  const configured =
    input.settings.includeRoot ??
    workspaceRootFor(documentPath, input.workspaceRoots) ??
    dirname(documentPath)

  // Canonicalize the root here as well as inside the resolver, so that the
  // root a caller sees on `includeRoot` is in the same coordinate system as
  // the ids the resolver returns. Without it, a root reached through a symlink
  // (or given relatively) makes every child id look like it sits outside the
  // root, and a diagnostic naming that child would print an absolute path.
  let root: string
  try {
    root = realpathSync(configured)
  } catch {
    return undefined
  }

  let resolver
  try {
    resolver = fileSystemResolver(root, {
      allowAbsolute: input.settings.allowAbsolute ?? false,
      allowedRemoteHosts: input.settings.allowedRemoteHosts ?? [],
      ...(input.cache === undefined ? {} : { cache: input.cache }),
    })
  } catch {
    // A root that is not a real directory yields no capability at all, rather
    // than a resolver that silently falls back to somewhere wider.
    return undefined
  }

  const options: IncludeOptions = { resolver, sourcePath: documentPath, includeRoot: root }
  if (input.settings.maxDepth !== undefined) options.maxDepth = input.settings.maxDepth
  if (input.settings.maxBytes !== undefined) options.maxBytes = input.settings.maxBytes
  return options
}
