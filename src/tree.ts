/** Small readers over the 0.2 tree that several features share. */
import type { CaptionNode } from './engine.js'

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
