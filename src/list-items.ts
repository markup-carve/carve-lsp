import { parse, type Position } from '@markup-carve/carve'
import { codepointColumnToUtf16, sourceLines } from './position.js'

export interface ItemSite {
  /** UTF-16 offset of the item's marker in its line; the text before it is the container lead. */
  character: number
  olType?: string
  delim?: string
  /** Identifies the list that holds the item. */
  list: string
  /** An earlier item of the same list, or of a list it is nested in, precedes this one. */
  continues: boolean
}

export interface ListItems {
  /** Zero-based line -> the outermost list item whose marker opens it. */
  starts: Map<number, ItemSite>
  /** Zero-based lines of paragraphs held directly by a list item, lazy lines included. */
  covered: Set<number>
}

interface Node { type?: unknown; pos?: Position; olType?: string; delim?: string }

/**
 * The list items of a document and the paragraph lines they hold. Walks the
 * whole document, so lists in quotes, divs, descriptions and footnote bodies
 * (`doc.footnoteDefs`) count; code, raw blocks and comments hold no items.
 */
export function listItems(source: string): ListItems | null {
  let doc: unknown
  try {
    doc = parse(source, { positions: true })
  } catch {
    return null
  }
  const lines = sourceLines(source)
  const starts = new Map<number, ItemSite>()
  const covered = new Set<number>()
  const ancestors: Node[] = []
  const visit = (value: unknown): void => {
    if (Array.isArray(value)) {
      for (const entry of value) visit(entry)
      return
    }
    if (value === null || typeof value !== 'object') return
    const node = value as Node
    const pos = node.pos
    if (node.type === 'paragraph' && ancestors.at(-1)?.type === 'list_item' && pos?.startLine !== undefined && pos.endLine !== undefined) {
      for (let line = pos.startLine - 1; line < pos.endLine; line++) covered.add(line)
    }
    if (node.type === 'list_item' && pos?.startLine !== undefined && pos.startColumn !== undefined && !starts.has(pos.startLine - 1)) {
      const line = pos.startLine - 1
      let list: Node | undefined
      let continues = false
      // Only list levels count: a quote or div between two items starts a new list context.
      for (let index = ancestors.length - 1; index >= 0; index--) {
        const ancestor = ancestors[index]!
        if (ancestor.type !== 'list' && ancestor.type !== 'list_item') break
        if (ancestor.type === 'list') list ??= ancestor
        if (ancestor.pos?.startLine !== undefined && ancestor.pos.startLine - 1 < line) continues = true
      }
      if (list?.pos) {
        starts.set(line, {
          character: codepointColumnToUtf16(lines[line] ?? '', pos.startColumn),
          olType: list.olType,
          delim: list.delim,
          list: `${list.pos.startLine}:${list.pos.startColumn}`,
          continues,
        })
      }
    }
    if (typeof node.type === 'string') ancestors.push(node)
    for (const key of Object.keys(node)) if (key !== 'pos') visit((node as Record<string, unknown>)[key])
    if (typeof node.type === 'string') ancestors.pop()
  }
  visit(doc)
  return { starts, covered }
}

/**
 * The item a content-less marker line would open once content lands, found by
 * parsing the document with that line completed. The engine decides whether
 * the marker is one, so its separator, numeral and container rules hold here
 * exactly as they do in a render.
 */
export function completedItem(source: string, line: number, text: string): ItemSite | undefined {
  const lines = sourceLines(source)
  if (line < 0 || line >= lines.length) return undefined
  lines[line] = text
  return listItems(lines.join('\n'))?.starts.get(line)
}

/**
 * Whether a content-less marker line belongs to a list: it is lazy text of an
 * item now, or it would continue a list once content lands. Returns the
 * completed item, whose `character` splits the container lead from the marker.
 */
export function bareMarkerItem(source: string, line: number, text: string): ItemSite | undefined {
  const item = completedItem(source, line, `${text}x`)
  if (!item) return undefined
  return item.continues || listItems(source)?.covered.has(line) ? item : undefined
}
