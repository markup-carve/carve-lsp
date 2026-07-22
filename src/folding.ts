import { type FoldingRange } from 'vscode-languageserver/node.js'
import { parse, resolve, type BlockNode, type Document } from '@markup-carve/carve'

/** Block kinds worth offering as a collapsible region when multi-line. */
const FOLDABLE = new Set<BlockNode['type']>([
  'code_block',
  'raw_block',
  'comment',
  'block_quote',
  'list',
  'table',
  'admonition',
  'div',
  'definition_list',
  'figure',
])

/**
 * Folding regions for a Carve document:
 *   - every multi-line block (code, admonition, div, list, table, …)
 *   - each heading's section, from the heading line down to the line before
 *     the next heading of the same or shallower level (or end of document).
 */
export function foldingRanges(source: string): FoldingRange[] {
  let doc: Document
  try {
    doc = resolve(parse(source, { positions: true }))
  } catch {
    return []
  }

  const ranges: FoldingRange[] = []
  const headings: Array<{ level: number; startLine: number }> = []

  const visit = (nodes: BlockNode[]): void => {
    for (const node of nodes) {
      if (node.type === 'heading' && node.pos) {
        headings.push({ level: node.level, startLine: node.pos.startLine })
      }
      if (node.pos && node.pos.endLine > node.pos.startLine && FOLDABLE.has(node.type)) {
        ranges.push({ startLine: node.pos.startLine - 1, endLine: node.pos.endLine - 1 })
      }
      if ('children' in node && Array.isArray(node.children)) {
        visit(node.children.filter(isBlockNode))
      }
    }
  }
  visit(doc.children)

  const lastLine = Math.max(0, source.split(/\r?\n/).length - 1)
  for (let i = 0; i < headings.length; i++) {
    const heading = headings[i]!
    let end = lastLine
    for (let j = i + 1; j < headings.length; j++) {
      if (headings[j]!.level <= heading.level) {
        end = headings[j]!.startLine - 2
        break
      }
    }
    if (end > heading.startLine - 1) {
      ranges.push({ startLine: heading.startLine - 1, endLine: end, kind: 'region' })
    }
  }

  return ranges
}

function isBlockNode(node: unknown): node is BlockNode {
  return Boolean(node && typeof node === 'object' && 'type' in node)
}
