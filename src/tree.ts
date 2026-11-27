/** Small readers over the 0.2 tree that several features share. */
import type { CaptionNode } from './engine.js'
import { astColumnToCharacter } from './position.js'

/** The id a heading answers to: its written `{#id}`, else the generated one. */
export function headingId(node: { attrs?: { id?: string }; generatedId?: string }): string | undefined {
  return node.attrs?.id ?? node.generatedId
}

/** The inline content of a caption: the children of its paragraphs, in order. */
export function captionInlines<T>(caption: CaptionNode | undefined): T[] {
  if (!caption) return []
  const out: T[] = []
  for (const block of caption.children) {
    if ('children' in block && Array.isArray(block.children) && (block.type === 'paragraph')) out.push(...(block.children as T[]))
  }
  return out
}

/** A 0.2 figure is a paragraph that holds an image and reads as one (`role: image`). */
export function isFigure(node: { type?: string; role?: unknown }): boolean {
  return node.type === 'paragraph' && node.role === 'image'
}

/** The document's footnote definitions as `[label, body]` pairs, in source order. */
export function footnoteEntries(doc: { children: readonly unknown[] }): Array<[string, unknown[]]> {
  const out: Array<[string, unknown[]]> = []
  for (const node of doc.children as Array<{ type?: string; key?: string; children?: unknown[] }>) {
    if (node.type === 'footnote' && node.key !== undefined) out.push([node.key, node.children ?? []])
  }
  return out
}

export interface FlatCell { header: boolean; children: Array<{ type?: string; value?: unknown; pos?: unknown; [key: string]: unknown }>; pos?: unknown; attrs?: unknown; colspan?: number; rowspan?: number; colSpan?: number; rowSpan?: number; [key: string]: unknown }
export interface FlatRow { cells: FlatCell[]; footer: boolean; pos?: unknown }

/**
 * A table's rows in source order, head, body and foot together. A cell's
 * `children` are its inlines when it holds one cell paragraph.
 */
export function tableRows(table: { children?: unknown }): FlatRow[] {
  const rows: FlatRow[] = []
  for (const group of (table.children ?? []) as Array<{ type?: string; children?: unknown[] }>) {
    if (group.type !== 'table_head' && group.type !== 'table_body' && group.type !== 'table_foot') continue
    for (const row of (group.children ?? []) as Array<{ type?: string; children?: unknown[]; pos?: unknown }>) {
      if (row.type !== 'table_row') continue
      rows.push({
        footer: group.type === 'table_foot',
        pos: row.pos,
        cells: ((row.children ?? []) as Array<{ header?: boolean; children?: Array<{ type?: string; children?: unknown[] }>; pos?: unknown }>).map((cell) => {
          const blocks = cell.children ?? []
          const inlines = blocks.length === 1 && blocks[0]!.type === 'cell_paragraph' ? (blocks[0]!.children ?? []) : blocks
          return { ...cell, header: cell.header === true, children: inlines as FlatCell['children'] }
        }),
      })
    }
  }
  return rows
}

const ATTRIBUTE_OR_COMMENT = /^[ \t>]*(?:(?:\{[^{}]*\})+|%%(?!%).*)[ \t]*$/

/**
 * The 0-based line a block's own markup opens on. A 0.2 span starts at the
 * attribute lines the block took (C2-A-148) and at comment-only lines between
 * them (C2-B-137); this skips those. The first line is read from the span's
 * column, so a list marker before an attribute block does not hide it.
 */
export function ownStartLine(pos: { startLine?: number; startColumn?: number; endLine?: number }, lines: readonly string[]): number {
  const first = pos.startLine ?? 1
  const last = (pos.endLine ?? first) - 1
  let line = first - 1
  while (line < last) {
    const text = lines[line] ?? ''
    const from = line === first - 1 && pos.startColumn !== undefined ? astColumnToCharacter(text, pos.startColumn) : 0
    if (!ATTRIBUTE_OR_COMMENT.test(text.slice(from))) break
    line += 1
  }
  return line
}

/** `pos` moved to the block's own first line (see `ownStartLine`); the column stays, as the container prefix does. */
export function ownPos<P extends { startLine?: number; startColumn?: number; endLine?: number }>(pos: P | undefined, lines: readonly string[]): P | undefined {
  if (pos?.startLine === undefined) return pos
  const line = ownStartLine(pos, lines) + 1
  return line === pos.startLine ? pos : { ...pos, startLine: line }
}

/**
 * `csv` or `tsv` for a delimited table (C2-B-180), read from its fence line:
 * the 0.2 tree keeps no source format on the table.
 */
export function delimitedTableFormat(node: { type?: string; pos?: { startLine?: number; startColumn?: number; endLine?: number } }, lines: readonly string[]): 'csv' | 'tsv' | undefined {
  if (node.type !== 'table' || node.pos?.startLine === undefined) return undefined
  const line = ownStartLine(node.pos, lines)
  const text = lines[line] ?? ''
  const from = line === node.pos.startLine - 1 && node.pos.startColumn !== undefined ? astColumnToCharacter(text, node.pos.startColumn) : 0
  const format = /^[ \t>]*(?:`{3,}|~{3,})[ \t]*(csv|tsv)\b/.exec(text.slice(from))?.[1]
  return format === 'csv' || format === 'tsv' ? format : undefined
}
