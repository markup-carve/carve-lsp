import { type Position, type Range } from 'vscode-languageserver-types'
import { parse, resolve, type Document } from '@markup-carve/carve'
import { walkNodes, type AstNode } from './ast-walk.js'
import { astOffsetToIndex } from './position.js'

export type SiteKind = 'heading' | 'caption' | 'footnote' | 'linkref'

/**
 * One navigable construct, read off the parsed document rather than the raw
 * text, so nothing inside code, raw blocks or comments counts.
 */
export interface ReferenceSite {
  kind: SiteKind
  /** Heading/caption id, footnote label, or normalized link-reference label. */
  key: string
  declaration: boolean
  /** The whole construct: `</#id>`, `[text](#id)`, `[^n]`, a heading line. */
  range: Range
  /** The identifier as written, or null when it is not written (a generated id, an implicit `[Heading][]`). */
  keyRange: Range | null
  /** A parser-derived heading id with no authored identifier. */
  generated?: boolean
  /** A collapsed `[Heading][]` the engine resolved to a heading; `label` holds its text as written. */
  implicit?: boolean
  /** Text before a heading's `#` on its line, for inserting an attribute line inside a container. */
  prefix?: string
  label?: string
  node?: AstNode
}

export interface ReferenceModel {
  text: string
  lines: string[]
  doc: Document | null
  sites: ReferenceSite[]
  /** String index ranges of code, raw, math and comment content. */
  verbatim: Array<{ start: number; end: number }>
  positionAt(index: number): Position
  offsetAt(position: Position): number
}

const VERBATIM = new Set(['code_block', 'raw_block', 'comment', 'code', 'raw_inline', 'math', 'frontmatter', 'autolink'])

export function normalizeLabel(label: string): string {
  return label.replace(/\s+/g, ' ').trim()
}

/** The key a collapsed `[Heading][]` matches heading text by: NFC, collapsed whitespace, case kept (PART 9R R1). */
export function implicitKey(text: string): string {
  return normalizeLabel(text.normalize('NFC'))
}

export function referenceModel(source: string): ReferenceModel {
  const text = source.replace(/\r\n?/g, '\n')
  const lines = text.split('\n')
  const lineStarts = [0]
  for (let index = 0; index < text.length; index += 1) if (text[index] === '\n') lineStarts.push(index + 1)
  const positionAt = (index: number): Position => {
    let low = 0
    let high = lineStarts.length - 1
    while (low < high) {
      const mid = (low + high + 1) >> 1
      if (lineStarts[mid]! <= index) low = mid
      else high = mid - 1
    }
    return { line: low, character: index - lineStarts[low]! }
  }
  const offsetAt = (position: Position): number =>
    Math.min(text.length, (lineStarts[position.line] ?? text.length) + position.character)
  const model: ReferenceModel = { text, lines, doc: null, sites: [], verbatim: [], positionAt, offsetAt }

  let doc: Document
  try {
    doc = resolve(parse(text, { positions: true }))
  } catch {
    return model
  }
  model.doc = doc
  const index = (offset: number): number => astOffsetToIndex(text, offset)
  const range = (start: number, end: number): Range => ({ start: positionAt(start), end: positionAt(end) })
  const span = (node: AstNode): { start: number; end: number } | null => {
    const pos = node.pos
    if (pos?.startOffset === undefined || pos.endOffset === undefined) return null
    return { start: index(pos.startOffset), end: index(pos.endOffset) }
  }

  const definedLabels = new Set<string>()
  walkNodes(doc, (node) => {
    if (node.type === 'link_reference_definition' && typeof node.label === 'string') definedLabels.add(normalizeLabel(node.label))
  })

  const sites = model.sites
  walkNodes(doc, (node, ancestors) => {
    const at = span(node)
    if (VERBATIM.has(node.type!)) {
      if (at) model.verbatim.push(at)
      return false
    }
    if (!at) return
    const attrId = (node.attrs as { id?: string } | undefined)?.id
    if (attrId && node.type !== 'heading' && !ancestors.some((ancestor) => INLINE_HOSTS.has(ancestor.type!))) {
      const authored = authoredId(lines, positionAt(at.start).line, attrId)
      if (authored) sites.push({ kind: 'caption', key: attrId, declaration: true, node, range: range(at.start, at.end), keyRange: authored })
    }
    switch (node.type) {
      case 'heading': {
        const id = (node.attrs as { id?: string } | undefined)?.id
        if (!id) return
        const children = Array.isArray(node.children) ? node.children as AstNode[] : []
        const first = children.find((child) => child.pos?.startOffset !== undefined)
        const lineIndex = positionAt(at.start).line
        const lineText = lines[lineIndex] ?? ''
        const prefix = lineText.slice(0, positionAt(at.start).character)
        const authored = authoredId(lines, lineIndex, id)
        const textStart = first ? index(first.pos!.startOffset!) : at.end
        sites.push({
          kind: 'heading', key: id, declaration: true, node, prefix,
          label: inlineText(children) || id,
          range: range(textStart, at.end),
          keyRange: authored,
          ...(authored ? {} : { generated: true }),
        })
        return
      }
      case 'heading_ref': {
        const target = node.target
        if (typeof target !== 'string') return
        const keyStart = at.start + 3
        const written = text.startsWith('</#', at.start) && text.slice(keyStart, keyStart + target.length) === target
        sites.push({ kind: 'heading', key: target, declaration: false, node, range: range(at.start, at.end), keyRange: written ? range(keyStart, keyStart + target.length) : null })
        return
      }
      case 'footnote_ref': {
        const id = (node as { label?: unknown }).label
        if (typeof id !== 'string') return
        const keyStart = at.start + 2
        const written = text.slice(keyStart, keyStart + id.length) === id
        sites.push({ kind: 'footnote', key: id, declaration: false, node, range: range(at.start, at.end), keyRange: written ? range(keyStart, keyStart + id.length) : null })
        return
      }
      case 'link_reference_definition': {
        const label = node.label
        if (typeof label !== 'string') return
        const lineIndex = positionAt(at.start).line
        const lineText = lines[lineIndex] ?? ''
        const column = lineText.indexOf(`[${label}]:`)
        if (column < 0) return
        const keyStart = lineStarts[lineIndex]! + column + 1
        sites.push({ kind: 'linkref', key: normalizeLabel(label), declaration: true, node, range: range(at.start, at.end), keyRange: range(keyStart, keyStart + label.length) })
        return
      }
      case 'link':
      case 'image': {
        const href = typeof node.href === 'string' ? node.href : ''
        const rawRef = typeof node.rawRef === 'string' ? node.rawRef : undefined
        const ref = typeof node.ref === 'string' ? node.ref : undefined
        if (rawRef !== undefined && ref !== undefined) {
          const key = normalizeLabel(ref)
          const collapsed = rawRef.endsWith('[]')
          const open = rawRef.startsWith('!') ? 2 : 1
          const rawLabel = collapsed ? rawRef.slice(open, -3) : rawRef.slice(rawRef.lastIndexOf('[') + 1, -1)
          const labelStart = collapsed ? at.start + open : at.end - 1 - rawLabel.length
          const written = text.slice(labelStart, labelStart + rawLabel.length) === rawLabel
          const keyRange = written ? range(labelStart, labelStart + rawLabel.length) : null
          if (!definedLabels.has(key) && collapsed && href.startsWith('#')) {
            sites.push({ kind: 'heading', key: href.slice(1), declaration: false, implicit: true, label: rawLabel, node, range: range(at.start, at.end), keyRange: null })
          } else {
            sites.push({ kind: 'linkref', key, declaration: false, node, range: range(at.start, at.end), keyRange })
          }
          return
        }
        if (href.startsWith('#') && href.length > 1) {
          const id = href.slice(1)
          const keyStart = text.lastIndexOf(`#${id}`, at.end) + 1
          const keyRange = keyStart > at.start ? range(keyStart, keyStart + id.length) : null
          sites.push({ kind: 'heading', key: id, declaration: false, node, range: range(at.start, at.end), keyRange })
        }
        return
      }
    }
  })

  const footnoteDefPos = (doc as { footnoteDefPos?: Record<string, { startOffset?: number }> }).footnoteDefPos ?? {}
  for (const [label, pos] of Object.entries(footnoteDefPos)) {
    if (pos.startOffset === undefined) continue
    const start = index(pos.startOffset)
    const column = text.indexOf(`[^${label}]:`, start)
    const lineEnd = text.indexOf('\n', start)
    if (column < 0 || (lineEnd >= 0 && column > lineEnd)) continue
    const keyStart = column + 2
    sites.push({ kind: 'footnote', key: label, declaration: true, range: range(column, keyStart + label.length + 1), keyRange: range(keyStart, keyStart + label.length) })
  }

  sites.sort((a, b) => a.range.start.line - b.range.start.line || a.range.start.character - b.range.start.character)
  return model
}

/** True when the string index lies inside code, raw, math or comment content. */
export function inVerbatim(model: ReferenceModel, index: number): boolean {
  return model.verbatim.some((range) => index >= range.start && index < range.end)
}

/** The innermost site whose range holds the position. */
export function siteAt(model: ReferenceModel, position: Position, filter: (site: ReferenceSite) => boolean = () => true): ReferenceSite | null {
  const hits = model.sites.filter((site) => filter(site) && (contains(site.range, position) || (site.keyRange !== null && contains(site.keyRange, position))))
  hits.sort((a, b) => size(a.range) - size(b.range))
  return hits[0] ?? null
}

export function contains(range: Range, position: Position): boolean {
  if (position.line < range.start.line || position.line > range.end.line) return false
  if (position.line === range.start.line && position.character < range.start.character) return false
  if (position.line === range.end.line && position.character > range.end.character) return false
  return true
}

function size(range: Range): number {
  return (range.end.line - range.start.line) * 1_000_000 + range.end.character - range.start.character
}

const INLINE_HOSTS = new Set(['paragraph', 'heading', 'table_cell', 'definition_term', 'line_block'])

/**
 * The `#id` an author wrote for a block, on the attribute lines directly above
 * it. Null when the id is the parser's own.
 */
function authoredId(lines: string[], blockLine: number, id: string): Range | null {
  const token = new RegExp(`[{\\s]#(${escapeRegExp(id)})(?=[\\s}])`)
  for (let line = blockLine - 1; line >= 0; line -= 1) {
    const text = lines[line]!
    if (!/\{[^{}]*\}\s*$/.test(text)) return null
    const match = token.exec(text)
    if (match) {
      const start = match.index + match[0].indexOf('#') + 1
      return { start: { line, character: start }, end: { line, character: start + id.length } }
    }
  }
  return null
}

function inlineText(nodes: AstNode[]): string {
  return nodes.map((node) => {
    if (typeof node.value === 'string') return node.value
    if (node.type === 'soft_break') return ' '
    if (Array.isArray(node.children)) return inlineText(node.children as AstNode[])
    return ''
  }).join('').trim()
}

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
}
