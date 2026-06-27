import { type Location, type Position } from 'vscode-languageserver/node.js'
import { parse, resolve, type BlockNode, type Document, type InlineNode } from '@markup-carve/carve'

/**
 * Go-to-definition for Carve constructs:
 *
 * - Cross-reference  `</#id>`         -> the heading whose generated id is `id`
 * - Fragment link    `[text](#id)`     -> same (href starts with `#`)
 * - Footnote ref     `[^name]`         -> the `[^name]:` definition line
 * - Link reference   `[text][ref]`     -> the `[ref]:` definition line
 * - Citation         `[@key]`          -> the `[@key]:` definition line
 * - Wikilink         `[[Page]]`        -> heading whose text matches Page (best-effort)
 */
export function definitionAt(uri: string, source: string, position: Position): Location | null {
  const lines = source.replace(/\r\n?/g, '\n').split('\n')
  const line = lines[position.line] ?? ''

  // 1. Citation [@key] - check before link-ref so `[@foo]` doesn't match as link-ref
  const citationTarget = resolveCitationAt(lines, line, position)
  if (citationTarget !== null) return locationAtLine(uri, citationTarget)

  // 2. Cross-reference </#id> or fragment link [text](#id)
  const crossrefTarget = resolveCrossrefAt(uri, source, line, position)
  if (crossrefTarget !== null) return crossrefTarget

  // 3. Footnote reference [^name]
  const footnoteTarget = resolveFootnoteAt(lines, line, position)
  if (footnoteTarget !== null) return locationAtLine(uri, footnoteTarget)

  // 4. Link reference [text][ref] or collapsed [ref][]
  const linkrefTarget = resolveLinkrefAt(lines, line, position)
  if (linkrefTarget !== null) return locationAtLine(uri, linkrefTarget)

  // 5. Wikilink [[Page]]
  const wikilinkTarget = resolveWikilinkAt(uri, source, line, position)
  if (wikilinkTarget !== null) return wikilinkTarget

  return null
}

// ---------------------------------------------------------------------------
// Citation: [@key] or [text; @key] -- navigate to the [@key]: definition line
// ---------------------------------------------------------------------------

function resolveCitationAt(lines: string[], line: string, position: Position): number | null {
  // Find all citation groups on the line: [...@key...]
  // A citation key appears after @ inside [...]
  const citationGroupRe = /\[([^\]]*@[^\]]*)\]/g
  for (const m of line.matchAll(citationGroupRe)) {
    const start = m.index!
    const end = start + m[0].length
    if (position.character < start || position.character >= end) continue
    // Extract the key that the cursor is on
    const inner = m[1]!
    // Keys: @key tokens separated by ; optionally prefixed with +/-
    const keyRe = /-?@([A-Za-z0-9_.:-]+)/g
    for (const km of inner.matchAll(keyRe)) {
      // offset of key label relative to full match
      const keyAbsStart = start + 1 + km.index! + 1 // skip '[' then '-?' then '@'
      const keyAbsEnd = keyAbsStart + km[1]!.length
      if (position.character < start + 1 + km.index! || position.character > keyAbsEnd) continue
      const key = km[1]!
      // Find [@key]: definition line
      return findCitationDef(lines, key)
    }
  }
  return null
}

function findCitationDef(lines: string[], key: string): number | null {
  const defRe = new RegExp(`^\\[@${escapeRegExp(key)}\\]:`)
  for (let i = 0; i < lines.length; i++) {
    if (defRe.test(lines[i]!)) return i
  }
  return null
}

// ---------------------------------------------------------------------------
// Cross-reference: </#id> or [text](#id) -> heading
// ---------------------------------------------------------------------------

function resolveCrossrefAt(uri: string, source: string, line: string, position: Position): Location | null {
  // Pattern 1: </#id>
  const crossrefRe = /<\/#([A-Za-z0-9_.:-]+)>/g
  for (const m of line.matchAll(crossrefRe)) {
    const start = m.index!
    const end = start + m[0].length
    if (position.character < start || position.character >= end) continue
    return findHeadingById(uri, source, m[1]!)
  }

  // Pattern 2: [text](#id) - inline link to a fragment
  const fragLinkRe = /\[[^\]]*\]\(#([A-Za-z0-9_.:-]+)[^)]*\)/g
  for (const m of line.matchAll(fragLinkRe)) {
    const start = m.index!
    const end = start + m[0].length
    if (position.character < start || position.character >= end) continue
    return findHeadingById(uri, source, m[1]!)
  }

  return null
}

function findHeadingById(uri: string, source: string, targetId: string): Location | null {
  let doc: Document
  try {
    doc = resolve(parse(source))
  } catch {
    return null
  }

  const heading = findHeadingWithId(doc.children, targetId.toLowerCase())
  if (!heading || !heading.pos) return null

  const line = heading.pos.startLine - 1
  return {
    uri,
    range: {
      start: { line, character: 0 },
      end: { line, character: (heading.pos.endColumn ?? 200) - 1 },
    },
  }
}

function findHeadingWithId(
  nodes: BlockNode[],
  targetId: string,
): import('@markup-carve/carve').Heading | null {
  for (const node of nodes) {
    if (node.type === 'heading') {
      const headingId = node.attrs?.id
      if (headingId && headingId.toLowerCase() === targetId) return node
    }
    if ('children' in node && Array.isArray(node.children)) {
      const found = findHeadingWithId(
        (node.children as BlockNode[]).filter(isBlockNode),
        targetId,
      )
      if (found) return found
    }
  }
  return null
}

function isBlockNode(node: unknown): node is BlockNode {
  return Boolean(node && typeof node === 'object' && 'type' in node)
}

// ---------------------------------------------------------------------------
// Footnote reference [^name] -> definition line [^name]: ...
// ---------------------------------------------------------------------------

function resolveFootnoteAt(lines: string[], line: string, position: Position): number | null {
  const fnRefRe = /\[\^([^\]\s]+)\]/g
  for (const m of line.matchAll(fnRefRe)) {
    const start = m.index!
    const end = start + m[0].length
    if (position.character < start || position.character >= end) continue
    const label = m[1]!
    // Find the definition (starts at line beginning: [^label]: ...)
    return findFootnoteDef(lines, label)
  }
  return null
}

function findFootnoteDef(lines: string[], label: string): number | null {
  const defRe = new RegExp(`^\\[\\^${escapeRegExp(label)}\\]:`)
  for (let i = 0; i < lines.length; i++) {
    if (defRe.test(lines[i]!)) return i
  }
  return null
}

// ---------------------------------------------------------------------------
// Link reference [text][ref] or [ref][] -> definition line [ref]: url
// ---------------------------------------------------------------------------

function resolveLinkrefAt(lines: string[], line: string, position: Position): number | null {
  // Match ][label] (full reference) or ][](collapsed) — exclude footnotes
  const fullRefRe = /\]\[([^\]^][^\]]*)\]/g
  for (const m of line.matchAll(fullRefRe)) {
    // cursor is on the label portion (after `][`)
    const labelStart = m.index! + 2
    const labelEnd = labelStart + m[1]!.length
    if (position.character < labelStart || position.character > labelEnd) continue
    const label = m[1]!
    return findLinkrefDef(lines, label)
  }

  // Collapsed reference: [ref][] — cursor on first bracket group
  const collapsedRe = /\[([^\]^][^\]]*)\]\[\]/g
  for (const m of line.matchAll(collapsedRe)) {
    const labelStart = m.index! + 1
    const labelEnd = labelStart + m[1]!.length
    if (position.character < labelStart || position.character > labelEnd) continue
    const label = m[1]!
    return findLinkrefDef(lines, label)
  }

  return null
}

function findLinkrefDef(lines: string[], label: string): number | null {
  const normalized = label.replace(/\s+/g, ' ').trim()
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i]!
    // Definition: [label]: url at line start (up to 3 leading spaces)
    const defMatch = /^( {0,3})\[([^\]]+)\]:/.exec(line)
    if (defMatch && !defMatch[2]!.startsWith('^')) {
      const defLabel = defMatch[2]!.replace(/\s+/g, ' ').trim()
      if (defLabel === normalized) return i
    }
  }
  return null
}

// ---------------------------------------------------------------------------
// Wikilink [[Page]] -> heading whose text matches Page
// ---------------------------------------------------------------------------

function resolveWikilinkAt(uri: string, source: string, line: string, position: Position): Location | null {
  const wikilinkRe = /\[\[([^\]|#]+?)(?:[|#][^\]]*)?]]/g
  for (const m of line.matchAll(wikilinkRe)) {
    const start = m.index!
    const end = start + m[0].length
    if (position.character < start || position.character >= end) continue
    const page = m[1]!.trim()
    return findHeadingByText(uri, source, page)
  }
  return null
}

function findHeadingByText(uri: string, source: string, text: string): Location | null {
  let doc: Document
  try {
    doc = resolve(parse(source))
  } catch {
    return null
  }

  const target = text.toLowerCase()
  const heading = findHeadingWithText(doc.children, target)
  if (!heading || !heading.pos) return null

  const line = heading.pos.startLine - 1
  return {
    uri,
    range: {
      start: { line, character: 0 },
      end: { line, character: (heading.pos.endColumn ?? 200) - 1 },
    },
  }
}

function headingPlainText(nodes: InlineNode[]): string {
  let out = ''
  for (const node of nodes) {
    if (node.type === 'text') out += node.value
    else if ('children' in node && Array.isArray(node.children)) {
      out += headingPlainText(node.children as InlineNode[])
    } else if (node.type === 'code') out += node.value
  }
  return out.trim()
}

function findHeadingWithText(
  nodes: BlockNode[],
  targetText: string,
): import('@markup-carve/carve').Heading | null {
  for (const node of nodes) {
    if (node.type === 'heading') {
      const text = headingPlainText(node.children).toLowerCase()
      if (text === targetText) return node
    }
    if ('children' in node && Array.isArray(node.children)) {
      const found = findHeadingWithText(
        (node.children as BlockNode[]).filter(isBlockNode),
        targetText,
      )
      if (found) return found
    }
  }
  return null
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function locationAtLine(uri: string, line: number): Location {
  return {
    uri,
    range: {
      start: { line, character: 0 },
      end: { line, character: 9999 },
    },
  }
}

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
}
