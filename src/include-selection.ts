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
import { parse, resolve, type BlockNode } from '@markup-carve/carve'
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
 * region, or null when the child has no such region (I1b).
 *
 * Mirrors `regionLines` in carve-js `src/includes.ts`, which the engine does
 * not export: a marker is `#region name` / `#endregion`, bare or after `//`.
 */
export function regionLines(source: string, selected: string): { start: number; end: number } | null {
  const lines = source.replace(/\r\n?/g, '\n').split('\n')
  if (lines.length > 1 && lines[lines.length - 1] === '') lines.pop()
  const seen = new Set<string>()
  const stack: Array<{ name: string; line: number }> = []
  let range: { start: number; end: number } | null = null
  for (const [index, sourceLine] of lines.entries()) {
    const line = sourceLine.replace(/^[ \t]+/, '')
    const body = line.startsWith('//') ? line.slice(2).replace(/^[ \t]+/, '') : line
    if (!/^#(?:end)?region\b/.test(body)) continue
    const marker = /^#(end)?region(?:[ \t]+([A-Za-z_][\w-]*))?[ \t]*$/.exec(body)
    if (!marker) return null
    const name = marker[2]
    if (marker[1]) {
      const open = stack.pop()
      if (!open || (name !== undefined && name !== open.name)) return null
      if (open.name === selected) range = { start: open.line + 2, end: index }
    } else {
      if (!name || seen.has(name)) return null
      seen.add(name)
      stack.push({ name, line: index })
    }
  }
  return stack.length === 0 ? range : null
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
