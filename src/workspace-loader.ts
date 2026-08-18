import { readdirSync, readFileSync, statSync } from 'node:fs'
import path from 'node:path'
import { pathToFileURL } from 'node:url'
import type { WorkspaceIndex } from './workspace-index.js'

export interface WorkspaceLoadResult {
  files: number
  bytes: number
  truncated: boolean
}

/** Bounded initial workspace census; open documents subsequently replace disk snapshots. */
export function indexWorkspace(
  index: WorkspaceIndex,
  roots: readonly string[],
  limits: { maxFiles?: number; maxBytes?: number } = {},
): WorkspaceLoadResult {
  const maxFiles = limits.maxFiles ?? 10_000
  const maxBytes = limits.maxBytes ?? 64 * 1024 * 1024
  let files = 0
  let bytes = 0
  let truncated = false
  const pending = [...roots]
  while (pending.length > 0) {
    const directory = pending.pop()!
    let entries
    try { entries = readdirSync(directory, { withFileTypes: true }) } catch { continue }
    for (const entry of entries) {
      if (entry.name === '.git' || entry.name === 'node_modules') continue
      const absolute = path.join(directory, entry.name)
      if (entry.isDirectory()) {
        pending.push(absolute)
        continue
      }
      if (!entry.isFile() || !entry.name.endsWith('.crv')) continue
      if (files >= maxFiles) { truncated = true; return { files, bytes, truncated } }
      try {
        const size = statSync(absolute).size
        if (bytes + size > maxBytes) { truncated = true; return { files, bytes, truncated } }
        index.update(pathToFileURL(absolute).toString(), readFileSync(absolute, 'utf8'), `disk:${statSync(absolute).mtimeMs}`)
        files += 1
        bytes += size
      } catch { /* A racing file is simply absent from this snapshot. */ }
    }
  }
  return { files, bytes, truncated }
}
