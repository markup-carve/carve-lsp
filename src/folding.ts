import { type FoldingRange } from 'vscode-languageserver-types'
import { type BlockNode, type Document, type Heading } from '@markup-carve/carve'
import { walkNodes, type AstNode } from './ast-walk.js'
import { resolvedDocument } from './parse-cache.js'
import { sourceLines } from './position.js'

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
 *   - every multi-line block (code, admonition, div, list, table, …), at any
 *     depth, and every multi-line footnote body
 *   - each heading's section (see `headingSections`).
 */
export function foldingRanges(source: string): FoldingRange[] {
  let doc: Document
  try {
    doc = resolvedDocument(source)
  } catch {
    return lexicalFolds(source)
  }

  const ranges: FoldingRange[] = []
  const fold = (pos: AstNode['pos']): void => {
    if (pos?.startLine !== undefined && pos.endLine !== undefined && pos.endLine > pos.startLine) {
      ranges.push({ startLine: pos.startLine - 1, endLine: pos.endLine - 1 })
    }
  }
  walkNodes(doc.children, (node) => {
    if (FOLDABLE.has(node.type as BlockNode['type'])) fold(node.pos)
    return !INLINE_HOSTS.has(node.type!)
  })
  for (const [label, body] of Object.entries(doc.footnoteDefs ?? {})) {
    fold(footnotePos(doc, label))
    walkNodes(body, (node) => {
      if (FOLDABLE.has(node.type as BlockNode['type'])) fold(node.pos)
      return !INLINE_HOSTS.has(node.type!)
    })
  }

  for (const section of headingSections(doc, sourceLines(source))) {
    if (section.endLine > section.startLine) {
      ranges.push({ startLine: section.startLine, endLine: section.endLine, kind: 'region' })
    }
  }

  return ranges
}

// Blocks whose children are inline only; the walk has no fold to find below them.
const INLINE_HOSTS = new Set(['paragraph', 'heading'])

export interface HeadingSection {
  heading: Heading
  /** 0-based line of the heading. */
  startLine: number
  /** 0-based last line of the section. */
  endLine: number
}

/**
 * Each heading's section, in source order: from the heading down to the line
 * before the next heading of the same or shallower level, never past the end
 * of the container the heading sits in.
 *
 * A terminating heading inside a container ends the section before that
 * container opens, and attribute lines above the terminator (which belong to
 * it) are left out.
 */
export function headingSections(doc: Document, lines: readonly string[]): HeadingSection[] {
  const found: Array<{ heading: Heading; ancestors: AstNode[] }> = []
  const collect = (root: unknown, outer: AstNode[]): void => {
    walkNodes(root, (node, ancestors) => {
      if (node.type === 'heading' && node.pos?.startLine !== undefined) {
        found.push({ heading: node as unknown as Heading, ancestors: [...outer, ...ancestors] })
      }
      return !INLINE_HOSTS.has(node.type!)
    })
  }
  collect(doc.children, [])
  for (const [label, body] of Object.entries(doc.footnoteDefs ?? {})) {
    collect(body, [{ type: 'footnote_definition', pos: footnotePos(doc, label) }])
  }
  found.sort((a, b) => a.heading.pos!.startLine - b.heading.pos!.startLine)

  // The next heading of the same or shallower level, found in one backward pass.
  const terminators: Array<(typeof found)[number] | undefined> = []
  const pending: typeof found = []
  for (let index = found.length - 1; index >= 0; index--) {
    const level = found[index]!.heading.level
    while (pending.length && pending[pending.length - 1]!.heading.level > level) pending.pop()
    terminators[index] = pending[pending.length - 1]
    pending.push(found[index]!)
  }

  const lastLine = Math.max(0, lines.length - 1)
  return found.map(({ heading, ancestors }, index) => {
    const startLine = heading.pos!.startLine - 1
    let endLine = lastLine

    const terminator = terminators[index]
    if (terminator) {
      const opener = terminator.ancestors.find((node) => !ancestors.includes(node) && node.pos?.startLine !== undefined)
      let line = (opener ?? terminator.heading).pos!.startLine! - 2
      while (line > startLine && ATTRIBUTE_LINE.test(lines[line] ?? '')) line--
      endLine = line
    }

    const container = [...ancestors].reverse().find((node) => node.pos?.endLine !== undefined)
    if (container) {
      let containerEnd = container.pos!.endLine! - 1
      if (containerEnd > startLine && isColonFenced(container) && FENCE_CLOSER.test(lines[containerEnd] ?? '')) containerEnd--
      endLine = Math.min(endLine, containerEnd)
    }

    return { heading, startLine, endLine: Math.max(startLine, endLine) }
  })
}

// A block attribute line, possibly under quote markers. `{{` opens an include, not attributes.
const ATTRIBUTE_LINE = /^[ \t>]*\{(?!\{)[^{}]*\}[ \t]*$/
const FENCE_CLOSER = /^[ \t>]*:{3,}[ \t]*$/

// Only a colon-fenced container owns its last line as a closer; elsewhere that line may close a child.
function isColonFenced(node: AstNode): boolean {
  return node.type === 'admonition' || node.type === 'div' || node.type === 'figure_group' || (node.type === 'block_quote' && node.fenced === true)
}

function footnotePos(doc: Document, label: string): AstNode['pos'] {
  return (doc as { footnoteDefPos?: Record<string, AstNode['pos']> }).footnoteDefPos?.[label]
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
