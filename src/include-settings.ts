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
  /**
   * Containment root override. Otherwise the workspace root, then the
   * document's directory.
   *
   * Only an ABSOLUTE, non-blank path is a root. See {@link usableIncludeRoot}
   * for why the other spellings are dropped rather than resolved.
   */
  includeRoot?: string
  /** Allow absolute include paths, still subject to root containment. */
  allowAbsolute?: boolean
  /** Hosts a remote include may name. Empty means none; this server never fetches. */
  allowedRemoteHosts?: string[]
  maxDepth?: number
  maxBytes?: number
  /** Resolver calls allowed for one walk. Default 1000. */
  maxResolverCalls?: number
}

export const DEFAULT_INCLUDE_SETTINGS: IncludeSettings = { enabled: 'auto' }

/**
 * Read `carve.includes` out of `initializationOptions` or a
 * `workspace/didChangeConfiguration` payload. Anything unrecognized falls back
 * to the default rather than being trusted as given.
 */
export function readIncludeSettings(raw: unknown, log?: (message: string) => void): IncludeSettings {
  const source = (raw as { carve?: { includes?: Record<string, unknown> } } | undefined)?.carve
    ?.includes
  if (!source || typeof source !== 'object') return DEFAULT_INCLUDE_SETTINGS
  const enabled = source['enabled']
  const settings: IncludeSettings = {
    enabled: enabled === 'on' || enabled === 'off' ? enabled : 'auto',
  }
  const configuredRoot = source['includeRoot']
  if (typeof configuredRoot === 'string') {
    const verdict = usableIncludeRoot(configuredRoot)
    if (verdict.root !== undefined) settings.includeRoot = verdict.root
    else log?.(ignoredIncludeRootMessage(configuredRoot, verdict.ignored))
  }
  if (typeof source['allowAbsolute'] === 'boolean') settings.allowAbsolute = source['allowAbsolute']
  if (Array.isArray(source['allowedRemoteHosts'])) {
    settings.allowedRemoteHosts = source['allowedRemoteHosts'].filter(
      (host): host is string => typeof host === 'string',
    )
  }
  if (typeof source['maxDepth'] === 'number') settings.maxDepth = source['maxDepth']
  if (typeof source['maxBytes'] === 'number') settings.maxBytes = source['maxBytes']
  if (typeof source['maxResolverCalls'] === 'number') {
    settings.maxResolverCalls = source['maxResolverCalls']
  }
  return settings
}

/**
 * Whether a configured `includeRoot` is usable as a containment root, and why
 * not when it is not.
 *
 * Both rejected spellings resolve against the PROCESS WORKING DIRECTORY, which
 * is the one root §19 containment must never have: a language server is
 * commonly spawned from the project the editor opened, from the user's home or
 * from `/`, and none of those is the workspace.
 *
 * - BLANK. `realpathSync('')` returns the process working directory and does
 *   NOT throw, so a blank value is not a value that fails - it is a value that
 *   silently succeeds at the wrong root. An editor returns `''` for an unset
 *   string setting, so a client forwarding its setting unchanged sends one by
 *   default.
 * - RELATIVE. The configuration protocol gives a relative path no base, so the
 *   only base available here is again the working directory. Resolving it
 *   against the workspace root instead would be a policy this server invented:
 *   it reads the client's intent, and a value such as `..` would widen the root
 *   ABOVE the workspace, which is the same escape by another route. Dropping it
 *   falls back to a root the client did name.
 *
 * Dropping is fail-closed in both cases: the fallback chain - workspace root,
 * then the document's own directory - is never wider than the workspace.
 */
export function usableIncludeRoot(
  value: string,
): { root: string; ignored?: undefined } | { root?: undefined; ignored: 'blank' | 'relative' } {
  if (value.trim() === '') return { ignored: 'blank' }
  if (!path.isAbsolute(value)) return { ignored: 'relative' }
  return { root: value }
}

export function ignoredIncludeRootMessage(value: string, reason: 'blank' | 'relative'): string {
  const because =
    reason === 'blank'
      ? 'it is blank'
      : `it is relative (${JSON.stringify(value)}), and a relative root would resolve against the server's working directory`
  return `Carve: ignoring carve.includes.includeRoot because ${because}; falling back to the workspace root.`
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

  // Defense in depth against a settings object built by hand rather than read
  // through `readIncludeSettings`: an unusable root is ABSENT here too, so the
  // fallback chain below is the same one an omitted key already takes.
  const override =
    input.settings.includeRoot === undefined
      ? undefined
      : usableIncludeRoot(input.settings.includeRoot).root

  const configured =
    override ?? workspaceRootFor(documentPath, input.workspaceRoots) ?? dirname(documentPath)

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
  if (input.settings.maxResolverCalls !== undefined) {
    options.maxResolverCalls = input.settings.maxResolverCalls
  }
  return options
}

/**
 * Include options for `carve.previewHtml`. The preview expands only under an
 * explicitly configured root; otherwise it renders the source as written.
 */
export function previewIncludeOptionsFor(input: IncludeGateInput): IncludeOptions | undefined {
  const configured = input.settings.includeRoot
  if (configured === undefined || usableIncludeRoot(configured).root === undefined) return undefined
  return includeOptionsFor(input)
}
