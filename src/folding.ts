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
  // A composite figure is a fenced container like any other, and a long one is
  // exactly what a reader wants to collapse (PART 9 §4c).
  'figure_group',
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
    return lexicalFolds(source)
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

export function lexicalFolds(source: string): FoldingRange[] {
  const lines = source.replace(/\r\n?/g, '\n').split('\n')
  const ranges: FoldingRange[] = []
  const headings: Array<{ level: number; line: number }> = []
  const fences: Array<{ marker: string; line: number }> = []
  for (let line = 0; line < lines.length; line += 1) {
    const text = lines[line]!
    const heading = /^(#{1,6}) /.exec(text)
    if (heading) headings.push({ level: heading[1]!.length, line })
    const fence = /^\s*(`{3,}|~{3,}|:{3,}|%{3,})/.exec(text)
    if (!fence) continue
    const top = fences.at(-1)
    if (top && top.marker[0] === fence[1]![0] && fence[1]!.length >= top.marker.length) {
      fences.pop()
      if (line > top.line) ranges.push({ startLine: top.line, endLine: line })
    } else {
      fences.push({ marker: fence[1]!, line })
    }
  }
  for (let index = 0; index < headings.length; index += 1) {
    const heading = headings[index]!
    const next = headings.slice(index + 1).find((candidate) => candidate.level <= heading.level)
    const endLine = (next?.line ?? lines.length) - 1
    if (endLine > heading.line) ranges.push({ startLine: heading.line, endLine, kind: 'region' })
  }
  return ranges
}

function isBlockNode(node: unknown): node is BlockNode {
  return Boolean(node && typeof node === 'object' && 'type' in node)
}
