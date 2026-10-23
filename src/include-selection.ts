/**
 * The selections an include directive can carry - `#section`, a line range
 * and a named region - resolved against a child's own source (PART 9 §19 I4, I5).
 *
 * Both are decidable from the child alone: no merge, no heading shift, no id
 * renaming. That is what lets this server diagnose and navigate them while
 * expansion itself still lives in the engine.
 *
 * Heading ids come from the resolver rather than a lexical scan, because the
 * resolver is authoritative for Unicode, inline markup and duplicate suffixes.
 * A lexical guess would report `include-section` against ids the engine
 * generates perfectly well, and a false diagnostic on a working document is
 * worse than a missing one.
 */
import { parse, resolve, selectIncludeRegion, type BlockNode } from '@markup-carve/carve'
import type { Range } from 'vscode-languageserver-types'

export interface Section {
  id: string
  range: Range
}

const HEADING_MARKER_RE = /^#{1,6}\s+/

/** Every heading id the child declares, in document order. */
export function sections(source: string): Section[] {
  const lines = source.replace(/\r\n?/g, '\n').split('\n')
  let document
  try {
    document = resolve(parse(source, { positions: true }))
  } catch {
    return []
  }
  const found: Section[] = []
  walk(document.children, (node) => {
    if (node.type !== 'heading' || !node.pos || !node.attrs?.id) return
    const line = node.pos.startLine - 1
    const text = lines[line] ?? ''
    const character = Math.min(text.length, HEADING_MARKER_RE.exec(text)?.[0].length ?? 0)
    found.push({
      id: node.attrs.id,
      range: { start: { line, character }, end: { line, character: text.length } },
    })
  })
  return found
}

/** Where a named section starts in the child, or undefined when it has none. */
export function sectionRange(source: string, id: string): Range | undefined {
  return sections(source).find((section) => section.id === id)?.range
}

/**
 * The 1-based line range inside a uniquely named, correctly paired comment
 * region, or null when the child has no such region (I1b). The engine decides:
 * a Carve include knows `%% #region`, a `@code` include also source comments.
 */
export function regionLines(source: string, selected: string, code = false): { start: number; end: number } | null {
  const result = selectIncludeRegion(source, selected, code ? 'code' : 'carve')
  return result.ok ? { start: result.start, end: result.end } : null
}

/**
 * The region names a child declares, in file order, read with the marker set
 * the include would use (I1b): a Carve include knows only `%% #region`, a
 * `@code` include also the source-comment forms. Empty when any marker is
 * malformed, unpaired or duplicated, since the engine then rejects every name.
 *
 * Follows the marker rules of `selectIncludeRegion`, which answers one name but
 * does not list them.
 */
export function regionNames(source: string, code: boolean): string[] {
  const names: string[] = []
  const open: string[] = []
  for (const sourceLine of source.split(/\r\n|[\r\n]/)) {
    const line = sourceLine.replace(/^[ \t]*/, '')
    let body: string
    let closer = ''
    if (line.startsWith('%%') && !line.startsWith('%%%')) body = line.slice(2)
    else if (!code) continue
    else if (line.startsWith('//') || line.startsWith('--')) body = line.slice(2)
    else if (line.startsWith('/*')) {
      body = line.slice(2)
      closer = String.raw`\*/`
    } else if (line.startsWith('<!--')) {
      body = line.slice(4)
      closer = '-->'
    } else body = line
    body = body.replace(/^[ \t]*/, '')
    if (!/^#(?:end)?region(?![A-Za-z0-9_])/.test(body)) continue
    const marker = new RegExp(`^#(end)?region(?:[ \t]+([A-Za-z_][\\w-]*))?[ \t]*${closer}[ \t]*$`).exec(body)
    if (!marker) return []
    const name = marker[2]
    if (marker[1]) {
      const opened = open.pop()
      if (opened === undefined || (name !== undefined && name !== opened)) return []
    } else {
      if (!name || names.includes(name)) return []
      names.push(name)
      open.push(name)
    }
  }
  return open.length === 0 ? names : []
}

/**
 * Lines as the line-range option counts them. A trailing newline does not open
 * a further line, so `@lines:3-3` on a three-line file is in range.
 */
export function lineCount(source: string): number {
  if (source === '') return 0
  const normalized = source.replace(/\r\n?/g, '\n')
  const lines = normalized.split('\n')
  if (lines.length > 1 && lines[lines.length - 1] === '') lines.pop()
  return lines.length
}

function walk(nodes: readonly BlockNode[], visit: (node: BlockNode) => void): void {
  for (const node of nodes) {
    visit(node)
    const children = (node as { children?: unknown }).children
    if (!Array.isArray(children)) continue
    walk(
      children.filter(
        (child): child is BlockNode =>
          Boolean(child && typeof child === 'object' && 'type' in child),
      ),
      visit,
    )
  }
}
