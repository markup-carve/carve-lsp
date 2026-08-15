import { type Location, type Position, type ReferenceContext } from 'vscode-languageserver/node.js'
import { parse, resolve, type BlockNode, type Document } from '@markup-carve/carve'
import { smartPunctuationText } from './inline-text.js'
import { captionTargetById, captionTargets } from './captions.js'

/**
 * Find-references for Carve constructs (same-document scope).
 *
 * Given the cursor position on either a definition or a usage, return ALL
 * usages (and optionally the definition itself when `context.includeDeclaration`).
 *
 * Supported families, mirroring definition.ts:
 * - Heading id  (on `#` heading line or on a `</#id>` / `[text](#id)` usage)
 * - Caption id  (on a `</#id>` usage, or on a captioned host's own declaration
 *                line - matched LAST, so a construct on that line still wins)
 * - Footnote    `[^name]` references and `[^name]:` definition
 * - Link-ref    `[text][ref]` / `[ref][]` usages and `[ref]:` definition
 * - Citation    `[@key]` usages and `[@key]:` definition
 * - Wikilink    `[[Page]]` usages (same-document headings only)
 */
export function referencesAt(
  uri: string,
  source: string,
  position: Position,
  context: ReferenceContext,
): Location[] | null {
  const lines = source.replace(/\r\n?/g, '\n').split('\n')
  const line = lines[position.line] ?? ''

  // Detect what construct the cursor sits on, then gather all locations.

  // 1. Heading id - cursor on the heading line itself or on a crossref usage
  const headingResult = resolveHeadingGroup(uri, source, lines, line, position, context)
  if (headingResult) return headingResult

  // 2. Footnote
  const footnoteResult = resolveFootnoteGroup(uri, lines, line, position, context)
  if (footnoteResult) return footnoteResult

  // 3. Citation
  const citationResult = resolveCitationGroup(uri, lines, line, position, context)
  if (citationResult) return citationResult

  // 4. Link reference
  const linkrefResult = resolveLinkrefGroup(uri, lines, line, position, context)
  if (linkrefResult) return linkrefResult

  // 5. Wikilink
  const wikilinkResult = resolveWikilinkGroup(uri, source, lines, line, position, context)
  if (wikilinkResult) return wikilinkResult

  // 6. A captioned host's own declaration line. LAST, because it is the only
  //    family matched by line rather than by a construct under the cursor - see
  //    resolveCaptionDeclarationGroup.
  const captionResult = resolveCaptionDeclarationGroup(uri, source, lines, position, context)
  if (captionResult) return captionResult

  return null
}

// ---------------------------------------------------------------------------
// Heading group: cursor on heading line, </#id>, or [text](#id)
// ---------------------------------------------------------------------------

function resolveHeadingGroup(
  uri: string,
  source: string,
  lines: string[],
  line: string,
  position: Position,
  context: ReferenceContext,
): Location[] | null {
  // Determine if cursor is on a heading line
  const headingMatch = /^(#{1,6})\s+/.exec(line)
  if (headingMatch) {
    const id = getHeadingId(source, position.line)
    if (id) {
      return collectRefs(uri, source, lines, id, { line: position.line, kind: 'heading' }, context)
    }
  }

  // Cursor on </#id>
  const crossrefRe = /<\/#([A-Za-z0-9_.:-]+)>/g
  for (const m of line.matchAll(crossrefRe)) {
    const start = m.index!
    const end = start + m[0].length
    if (position.character < start || position.character >= end) continue
    const id = m[1]!
    const declaration = findDeclarationById(source, id)
    if (declaration === null) return []
    return collectRefs(uri, source, lines, id, declaration, context)
  }

  // Cursor on [text](#id)
  const fragLinkRe = /\[[^\]]*\]\(#([A-Za-z0-9_.:-]+)[^)]*\)/g
  for (const m of line.matchAll(fragLinkRe)) {
    const start = m.index!
    const end = start + m[0].length
    if (position.character < start || position.character >= end) continue
    const id = m[1]!
    const declaration = findDeclarationById(source, id)
    if (declaration === null) return []
    return collectRefs(uri, source, lines, id, declaration, context)
  }

  return null
}

/**
 * Cursor on the DECLARATION of a captioned host. A heading declares its id on
 * its own line, and asking there works; a captioned host declares it on the
 * block-attribute line ABOVE itself, and asking there answered nothing - so the
 * feature was reachable from a usage only, which is half of what this module
 * documents.
 *
 * IT RUNS LAST, and that ordering is the rule rather than an accident. This is
 * the only family matched by LINE rather than by a construct under the cursor,
 * so it answers for every column on that line - including a column holding
 * something else. A host line can carry a reference image (`![alt][img]`), and
 * running this before the link-reference family answered the FIGURE's
 * references for a cursor sitting on `img`.
 */
function resolveCaptionDeclarationGroup(
  uri: string,
  source: string,
  lines: string[],
  position: Position,
  context: ReferenceContext,
): Location[] | null {
  const declared = captionIdDeclaredAt(source, position.line)
  if (declared === null) return null
  const declaration = findDeclarationById(source, declared)
  if (declaration === null) return []
  return collectRefs(uri, source, lines, declared, declaration, context)
}

/**
 * The caption id a source line DECLARES: the host's own first line, or the line
 * immediately above it, which is where the id is written. The attribute line
 * sits OUTSIDE the host's span, so it is matched by adjacency rather than by
 * containment.
 *
 * NO SHAPE TEST ON THE LINE ABOVE, deliberately. A `/^\s*\{.*\}\s*$/` guard
 * reads like a safety check and is not one: a host only HAS an id because a
 * block-attribute line gave it one, so the line above a host in this list is
 * that line by construction, and the guard can only ever reject a spelling of
 * it - `> {#fig}` inside a block quote, which the anchored brace does not
 * match. A check that cannot reject a wrong answer and can reject a right one
 * is worse than no check.
 */
function captionIdDeclaredAt(source: string, lineIndex: number): string | null {
  let doc: Document
  try {
    doc = resolve(parse(source, { positions: true }))
  } catch {
    return null
  }
  for (const target of captionTargets(doc)) {
    if (!target.pos) continue
    const hostLine = target.pos.startLine - 1
    if (lineIndex === hostLine || lineIndex === hostLine - 1) return target.id
  }
  return null
}

function getHeadingId(source: string, lineIndex: number): string | null {
  let doc: Document
  try {
    doc = resolve(parse(source))
  } catch {
    return null
  }
  const heading = findHeadingAtLine(doc.children, lineIndex + 1) // pos is 1-based
  return heading?.attrs?.id ?? null
}

function findHeadingAtLine(
  nodes: BlockNode[],
  line: number,
): import('@markup-carve/carve').Heading | null {
  for (const node of nodes) {
    if (node.type === 'heading' && node.pos?.startLine === line) return node
    if ('children' in node && Array.isArray(node.children)) {
      const found = findHeadingAtLine((node.children as BlockNode[]).filter(isBlockNode), line)
      if (found) return found
    }
  }
  return null
}

/**
 * Where a crossref id is declared, and WHAT declares it: a heading's own line,
 * or a captioned host's first line. Headings alone were searched here, so
 * asking for the usages of a figure id found the group and then returned
 * nothing.
 *
 * The kind is not decoration. A COLLAPSED reference `[text][]` falls back to
 * the implicit HEADING target (PART 9R R1) and to nothing else - `[foo][]`
 * beside a figure `{#foo}` renders as literal text - so the usage scan that
 * looks for it must run for one kind and not the other.
 */
function findDeclarationById(
  source: string,
  targetId: string,
): { line: number; kind: 'heading' | 'caption' } | null {
  let doc: Document
  try {
    doc = resolve(parse(source, { positions: true }))
  } catch {
    return null
  }
  const heading = findHeadingWithId(doc.children, targetId.toLowerCase())
  if (heading?.pos) return { line: heading.pos.startLine - 1, kind: 'heading' }
  const caption = captionTargetById(doc, targetId)
  if (caption?.pos) return { line: caption.pos.startLine - 1, kind: 'caption' }
  return null
}

function findHeadingWithId(
  nodes: BlockNode[],
  targetId: string,
): import('@markup-carve/carve').Heading | null {
  for (const node of nodes) {
    if (node.type === 'heading') {
      const id = node.attrs?.id
      if (id && id.toLowerCase() === targetId) return node
    }
    if ('children' in node && Array.isArray(node.children)) {
      const found = findHeadingWithId((node.children as BlockNode[]).filter(isBlockNode), targetId)
      if (found) return found
    }
  }
  return null
}

/**
 * Every usage of an id, for a declaration that may be a heading or a captioned
 * host.
 *
 * The families differ in exactly one usage form. A COLLAPSED reference
 * `[text][]` falls back to the implicit HEADING target (PART 9R R1) and to
 * nothing else, so `[foo][]` beside a figure `{#foo}` renders as literal text
 * rather than reaching the figure. Reporting it as a usage of the figure would
 * be a reference the author cannot follow and did not write.
 */
function collectRefs(
  uri: string,
  source: string,
  lines: string[],
  id: string,
  declaration: { line: number; kind: 'heading' | 'caption' },
  context: ReferenceContext,
): Location[] {
  const locs: Location[] = []
  const defLine = declaration.line

  // Optionally include the definition (the declaring line itself)
  if (context.includeDeclaration) {
    locs.push(lineLocation(uri, defLine, 0, lines[defLine]?.length ?? 0))
  }

  const idLower = id.toLowerCase()

  // Collect </#id> usages
  const crossrefRe = /<\/#([A-Za-z0-9_.:-]+)>/g
  for (let i = 0; i < lines.length; i++) {
    for (const m of lines[i]!.matchAll(crossrefRe)) {
      if (m[1]!.toLowerCase() === idLower) {
        locs.push(lineLocation(uri, i, m.index!, m.index! + m[0].length))
      }
    }
  }

  // Collect [text](#id) fragment links
  const fragLinkRe = /\[[^\]]*\]\(#([A-Za-z0-9_.:-]+)[^)]*\)/g
  for (let i = 0; i < lines.length; i++) {
    for (const m of lines[i]!.matchAll(fragLinkRe)) {
      if (m[1]!.toLowerCase() === idLower) {
        locs.push(lineLocation(uri, i, m.index!, m.index! + m[0].length))
      }
    }
  }

  // Collect implicit heading references [Heading text][] via resolve()
  // These are resolved to `href` in the AST, so we check the link pool from
  // semantic analysis. For simplicity we scan for [text][] where text lowercased
  // matches the heading id (djot implicit ref: whitespace-collapsed, lowercase).
  // HEADINGS ONLY - see the note on this function.
  if (declaration.kind === 'heading') {
    const implicitRefRe = /\[([^\]\n]+)\]\[\]/g
    for (let i = 0; i < lines.length; i++) {
      for (const m of lines[i]!.matchAll(implicitRefRe)) {
        const slug = m[1]!.trim().toLowerCase().replace(/\s+/g, '-')
        if (slug === idLower) {
          locs.push(lineLocation(uri, i, m.index!, m.index! + m[0].length))
        }
      }
    }
  }

  return dedup(locs)
}

// ---------------------------------------------------------------------------
// Footnote group
// ---------------------------------------------------------------------------

function resolveFootnoteGroup(
  uri: string,
  lines: string[],
  line: string,
  position: Position,
  context: ReferenceContext,
): Location[] | null {
  // Cursor on a footnote ref or def
  const fnAnyRe = /\[\^([^\]\s]+)\]/g
  for (const m of line.matchAll(fnAnyRe)) {
    const start = m.index!
    const end = start + m[0].length
    if (position.character < start || position.character >= end) continue
    const label = m[1]!
    return collectFootnoteRefs(uri, lines, label, context)
  }
  return null
}

function collectFootnoteRefs(
  uri: string,
  lines: string[],
  label: string,
  context: ReferenceContext,
): Location[] {
  const locs: Location[] = []
  const defRe = new RegExp(`^\\[\\^${escapeRegExp(label)}\\]:`)
  const refRe = new RegExp(`\\[\\^${escapeRegExp(label)}\\]`, 'g')

  for (let i = 0; i < lines.length; i++) {
    const l = lines[i]!
    const isDef = defRe.test(l)

    for (const m of l.matchAll(refRe)) {
      if (isDef && !context.includeDeclaration) continue
      locs.push(lineLocation(uri, i, m.index!, m.index! + m[0].length))
    }
  }

  return locs
}

// ---------------------------------------------------------------------------
// Citation group
// ---------------------------------------------------------------------------

function resolveCitationGroup(
  uri: string,
  lines: string[],
  line: string,
  position: Position,
  context: ReferenceContext,
): Location[] | null {
  // Cursor on a citation definition line [@key]:
  const citDefRe = /^\[@([A-Za-z0-9_.:-]+)\]:/
  const defMatch = citDefRe.exec(line)
  if (defMatch) {
    const keyStart = 2 // after '[@'
    const keyEnd = keyStart + defMatch[1]!.length
    if (position.character >= keyStart && position.character <= keyEnd) {
      return collectCitationRefs(uri, lines, defMatch[1]!, context)
    }
  }

  // Cursor on a citation usage [@key] inside [...]
  const citGroupRe = /\[([^\]]*@[^\]]*)\]/g
  for (const m of line.matchAll(citGroupRe)) {
    const start = m.index!
    const end = start + m[0].length
    if (position.character < start || position.character >= end) continue
    const inner = m[1]!
    const keyRe = /-?@([A-Za-z0-9_.:-]+)/g
    for (const km of inner.matchAll(keyRe)) {
      const keyAbsStart = start + 1 + km.index! + (km[0]!.startsWith('-') ? 2 : 1)
      const keyAbsEnd = keyAbsStart + km[1]!.length
      if (position.character < start + 1 + km.index! || position.character > keyAbsEnd) continue
      return collectCitationRefs(uri, lines, km[1]!, context)
    }
  }

  return null
}

function collectCitationRefs(
  uri: string,
  lines: string[],
  key: string,
  context: ReferenceContext,
): Location[] {
  const locs: Location[] = []
  const defRe = new RegExp(`^\\[@${escapeRegExp(key)}\\]:`)
  const usageRe = new RegExp(`-?@${escapeRegExp(key)}(?=[\\];, ])`, 'g')

  for (let i = 0; i < lines.length; i++) {
    const l = lines[i]!
    const isDef = defRe.test(l)

    if (isDef && context.includeDeclaration) {
      // Emit the whole definition line
      locs.push(lineLocation(uri, i, 0, l.length))
      continue
    }

    if (!isDef) {
      for (const m of l.matchAll(usageRe)) {
        // Only within a citation group [...]
        locs.push(lineLocation(uri, i, m.index!, m.index! + m[0].length))
      }
    }
  }

  return locs
}

// ---------------------------------------------------------------------------
// Link-reference group
// ---------------------------------------------------------------------------

function resolveLinkrefGroup(
  uri: string,
  lines: string[],
  line: string,
  position: Position,
  context: ReferenceContext,
): Location[] | null {
  // Cursor on definition: [label]: url at line start
  const defMatch = /^( {0,3})\[([^\]^][^\]]*)\]:/.exec(line)
  if (defMatch) {
    const labelStart = defMatch[1]!.length + 1
    const labelEnd = labelStart + defMatch[2]!.length
    if (position.character >= labelStart && position.character <= labelEnd) {
      return collectLinkrefRefs(uri, lines, defMatch[2]!, context)
    }
  }

  // Cursor on full reference ][label]
  const fullRefRe = /\]\[([^\]^][^\]]*)\]/g
  for (const m of line.matchAll(fullRefRe)) {
    const labelStart = m.index! + 2
    const labelEnd = labelStart + m[1]!.length
    if (position.character < labelStart || position.character > labelEnd) continue
    return collectLinkrefRefs(uri, lines, m[1]!, context)
  }

  // Cursor on collapsed [ref][]
  const collapsedRe = /\[([^\]^][^\]]*)\]\[\]/g
  for (const m of line.matchAll(collapsedRe)) {
    const labelStart = m.index! + 1
    const labelEnd = labelStart + m[1]!.length
    if (position.character < labelStart || position.character > labelEnd) continue
    return collectLinkrefRefs(uri, lines, m[1]!, context)
  }

  return null
}

function collectLinkrefRefs(
  uri: string,
  lines: string[],
  label: string,
  context: ReferenceContext,
): Location[] {
  const locs: Location[] = []
  const normalized = label.replace(/\s+/g, ' ').trim()
  const defRe = /^( {0,3})\[([^\]^][^\]]*)\]:/

  for (let i = 0; i < lines.length; i++) {
    const l = lines[i]!
    const defM = defRe.exec(l)
    if (defM) {
      const defLabel = defM[2]!.replace(/\s+/g, ' ').trim()
      if (defLabel === normalized && context.includeDeclaration) {
        const labelStart = defM[1]!.length + 1
        locs.push(lineLocation(uri, i, labelStart, labelStart + defM[2]!.length))
      }
      continue
    }

    // Full reference ][label]
    const fullRefRe = /\]\[([^\]^][^\]]*)\]/g
    for (const m of l.matchAll(fullRefRe)) {
      const refLabel = m[1]!.replace(/\s+/g, ' ').trim()
      if (refLabel === normalized) {
        const labelStart = m.index! + 2
        locs.push(lineLocation(uri, i, labelStart, labelStart + m[1]!.length))
      }
    }

    // Collapsed [ref][]
    const collapsedRe = /\[([^\]^][^\]]*)\]\[\]/g
    for (const m of l.matchAll(collapsedRe)) {
      const refLabel = m[1]!.replace(/\s+/g, ' ').trim()
      if (refLabel === normalized) {
        const labelStart = m.index! + 1
        locs.push(lineLocation(uri, i, labelStart, labelStart + m[1]!.length))
      }
    }
  }

  return locs
}

// ---------------------------------------------------------------------------
// Wikilink group
// ---------------------------------------------------------------------------

function resolveWikilinkGroup(
  uri: string,
  source: string,
  lines: string[],
  line: string,
  position: Position,
  context: ReferenceContext,
): Location[] | null {
  const wikilinkRe = /\[\[([^\]|#]+?)(?:[|#][^\]]*)?]]/g
  for (const m of line.matchAll(wikilinkRe)) {
    const start = m.index!
    const end = start + m[0].length
    if (position.character < start || position.character >= end) continue
    const page = m[1]!.trim()
    return collectWikilinkRefs(uri, source, lines, page, context)
  }
  return null
}

function collectWikilinkRefs(
  uri: string,
  source: string,
  lines: string[],
  page: string,
  context: ReferenceContext,
): Location[] {
  const locs: Location[] = []
  const pageLower = page.toLowerCase()

  // Optionally include the heading that this wikilink resolves to
  if (context.includeDeclaration) {
    const defLine = findHeadingLineByText(source, pageLower)
    if (defLine !== null) {
      locs.push(lineLocation(uri, defLine, 0, lines[defLine]?.length ?? 0))
    }
  }

  // Collect all [[Page]] usages matching the same page (case-insensitive)
  const wikilinkRe = /\[\[([^\]|#]+?)(?:[|#][^\]]*)?]]/g
  for (let i = 0; i < lines.length; i++) {
    for (const m of lines[i]!.matchAll(wikilinkRe)) {
      if (m[1]!.trim().toLowerCase() === pageLower) {
        locs.push(lineLocation(uri, i, m.index!, m.index! + m[0].length))
      }
    }
  }

  return locs
}

function findHeadingLineByText(source: string, targetText: string): number | null {
  let doc: Document
  try {
    doc = resolve(parse(source))
  } catch {
    return null
  }

  const heading = findHeadingWithText(doc.children, targetText)
  if (!heading || !heading.pos) return null
  return heading.pos.startLine - 1
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
      const found = findHeadingWithText((node.children as BlockNode[]).filter(isBlockNode), targetText)
      if (found) return found
    }
  }
  return null
}

function headingPlainText(nodes: import('@markup-carve/carve').InlineNode[]): string {
  let out = ''
  for (const node of nodes) {
    if (node.type === 'text') out += node.value
    else if ('children' in node && Array.isArray(node.children)) {
      out += headingPlainText(node.children as import('@markup-carve/carve').InlineNode[])
    } else if (node.type === 'code') out += node.value
    // An inline literal (§27) renders as visible prose, so it must contribute
    // to the heading text used for cross-reference and rename matching.
    else if (node.type === 'literal_inline') out += node.content
    else out += smartPunctuationText(node)
  }
  return out.trim()
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function isBlockNode(node: unknown): node is BlockNode {
  return Boolean(node && typeof node === 'object' && 'type' in node)
}

function lineLocation(uri: string, line: number, startChar: number, endChar: number): Location {
  return {
    uri,
    range: {
      start: { line, character: startChar },
      end: { line, character: endChar },
    },
  }
}

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
}

function dedup(locs: Location[]): Location[] {
  const seen = new Set<string>()
  return locs.filter((loc) => {
    const key = `${loc.uri}:${loc.range.start.line}:${loc.range.start.character}`
    if (seen.has(key)) return false
    seen.add(key)
    return true
  })
}
