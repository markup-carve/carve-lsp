import { type Location, type Position, type ReferenceContext } from 'vscode-languageserver-types'
import { type Document, type InlineNode } from '@markup-carve/carve'
import { smartPunctuationText } from './inline-text.js'
import { captionTargetById, captionTargets } from './captions.js'
import { walkNodes } from './ast-walk.js'
import { implicitKey, inVerbatim, referenceModel, siteAt, type ReferenceModel } from './reference-sites.js'

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
  const model = referenceModel(source)
  const lines = model.lines
  const line = lines[position.line] ?? ''
  if (inVerbatim(model, model.offsetAt(position))) return null

  // Detect what construct the cursor sits on, then gather all locations.

  // 1. Heading id - cursor on the heading line itself or on a crossref usage
  const headingResult = resolveHeadingGroup(uri, model, position, context)
  if (headingResult) return headingResult

  // 2. Footnote
  const footnoteResult = resolveFootnoteGroup(uri, model, position, context)
  if (footnoteResult) return footnoteResult

  // 3. Citation
  const citationResult = resolveCitationGroup(uri, model, line, position, context)
  if (citationResult) return citationResult

  // 4. Link reference
  const linkrefResult = resolveLinkrefGroup(uri, model, position, context)
  if (linkrefResult) return linkrefResult

  // 5. Wikilink
  const wikilinkResult = resolveWikilinkGroup(uri, model, line, position, context)
  if (wikilinkResult) return wikilinkResult

  // 6. A captioned host's own declaration line. LAST, because it is the only
  //    family matched by line rather than by a construct under the cursor - see
  //    resolveCaptionDeclarationGroup.
  const captionResult = resolveCaptionDeclarationGroup(uri, model, position, context)
  if (captionResult) return captionResult

  return null
}

// ---------------------------------------------------------------------------
// Heading group: cursor on heading line, </#id>, or [text](#id)
// ---------------------------------------------------------------------------

function resolveHeadingGroup(
  uri: string,
  model: ReferenceModel,
  position: Position,
  context: ReferenceContext,
): Location[] | null {
  // Cursor anywhere on a heading's line
  const heading = model.sites.find((site) =>
    site.kind === 'heading' && site.declaration && site.node?.pos?.startLine === position.line + 1)
  if (heading) {
    const text = implicitKey(headingPlainText((heading.node!.children ?? []) as InlineNode[]))
    return collectRefs(uri, model, heading.key, { line: position.line, kind: 'heading', text }, context)
  }

  // Cursor on </#id>, [text](#id) or a collapsed [Heading][]
  const usage = siteAt(model, position, (site) => site.kind === 'heading' && !site.declaration)
  if (!usage) return null
  const declaration = findDeclarationById(model, usage.key)
  if (declaration === null) return []
  return collectRefs(uri, model, usage.key, declaration, context)
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
  model: ReferenceModel,
  position: Position,
  context: ReferenceContext,
): Location[] | null {
  const declared = captionIdDeclaredAt(model, position.line)
  if (declared === null) return null
  const declaration = findDeclarationById(model, declared)
  if (declaration === null) return []
  return collectRefs(uri, model, declared, declaration, context)
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
function captionIdDeclaredAt(model: ReferenceModel, lineIndex: number): string | null {
  if (!model.doc) return null
  for (const target of captionTargets(model.doc)) {
    if (!target.pos) continue
    const hostLine = target.pos.startLine - 1
    if (lineIndex === hostLine || lineIndex === hostLine - 1) return target.id
  }
  return null
}

type Declaration = { line: number; kind: 'heading' | 'caption'; text?: string }

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
  model: ReferenceModel,
  targetId: string,
): Declaration | null {
  const doc = model.doc
  if (!doc) return null
  const heading = findHeading(doc, (candidate) => candidate.attrs?.id === targetId)
  if (heading?.pos) {
    return {
      line: heading.pos.startLine - 1,
      kind: 'heading',
      text: implicitKey(headingPlainText(heading.children)),
    }
  }
  const caption = captionTargetById(doc, targetId)
  if (caption?.pos) return { line: caption.pos.startLine - 1, kind: 'caption' }
  return null
}

type Heading = import('@markup-carve/carve').Heading

/** The first heading anywhere in the document - list items and footnote bodies included - that matches. */
function findHeading(doc: Document, matches: (heading: Heading) => boolean): Heading | null {
  let found: Heading | null = null
  walkNodes(doc, (node) => {
    if (found) return false
    if (node.type === 'heading' && matches(node as unknown as Heading)) found = node as unknown as Heading
  })
  return found
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
  model: ReferenceModel,
  id: string,
  declaration: Declaration,
  context: ReferenceContext,
): Location[] {
  const locs: Location[] = []
  const defLine = declaration.line

  // Optionally include the definition (the declaring line itself)
  if (context.includeDeclaration) {
    locs.push(lineLocation(uri, defLine, 0, model.lines[defLine]?.length ?? 0))
  }

  for (const site of model.sites) {
    if (site.kind !== 'heading' || site.declaration || site.key !== id) continue
    // A collapsed [text][] reaches headings only, and only when it spells the
    // heading's text exactly - see the note on this function.
    if (site.implicit && (declaration.kind !== 'heading' || declaration.text !== implicitKey(site.label ?? ''))) continue
    locs.push({ uri, range: site.range })
  }

  return dedup(locs)
}

// ---------------------------------------------------------------------------
// Footnote group
// ---------------------------------------------------------------------------

function resolveFootnoteGroup(
  uri: string,
  model: ReferenceModel,
  position: Position,
  context: ReferenceContext,
): Location[] | null {
  const target = siteAt(model, position, (site) => site.kind === 'footnote')
  if (!target) return null
  return model.sites
    .filter((site) => site.kind === 'footnote' && site.key === target.key && (context.includeDeclaration || !site.declaration))
    .map((site) => ({ uri, range: site.range }))
}

// ---------------------------------------------------------------------------
// Citation group
// ---------------------------------------------------------------------------

function resolveCitationGroup(
  uri: string,
  model: ReferenceModel,
  line: string,
  position: Position,
  context: ReferenceContext,
): Location[] | null {
  // Cursor on a citation definition line [@key]:
  const citDefRe = /^\[@([\p{L}\p{N}_.:+-]+)\]:/u
  const defMatch = citDefRe.exec(line)
  if (defMatch) {
    const keyStart = 2 // after '[@'
    const keyEnd = keyStart + defMatch[1]!.length
    if (position.character >= keyStart && position.character <= keyEnd) {
      return collectCitationRefs(uri, model, defMatch[1]!, context)
    }
  }

  // Cursor on a citation usage [@key] inside [...]
  const citGroupRe = /\[([^\]]*@[^\]]*)\]/g
  for (const m of line.matchAll(citGroupRe)) {
    const start = m.index!
    const end = start + m[0].length
    if (position.character < start || position.character >= end) continue
    const inner = m[1]!
    const keyRe = /-?@([\p{L}\p{N}_.:+-]+)/gu
    for (const km of inner.matchAll(keyRe)) {
      const keyAbsStart = start + 1 + km.index! + (km[0]!.startsWith('-') ? 2 : 1)
      const keyAbsEnd = keyAbsStart + km[1]!.length
      if (position.character < start + 1 + km.index! || position.character > keyAbsEnd) continue
      return collectCitationRefs(uri, model, km[1]!, context)
    }
  }

  return null
}

function collectCitationRefs(
  uri: string,
  model: ReferenceModel,
  key: string,
  context: ReferenceContext,
): Location[] {
  const locs: Location[] = []
  const lines = model.lines
  let offset = 0
  const defRe = new RegExp(`^\\[@${escapeRegExp(key)}\\]:`)
  const usageRe = new RegExp(`-?@${escapeRegExp(key)}(?=[\\];, ])`, 'g')

  for (let i = 0; i < lines.length; i++) {
    const l = lines[i]!
    const lineStart = offset
    offset += l.length + 1
    const isDef = defRe.test(l) && !inVerbatim(model, lineStart)

    if (isDef && context.includeDeclaration) {
      // Emit the whole definition line
      locs.push(lineLocation(uri, i, 0, l.length))
      continue
    }

    if (!isDef) {
      for (const m of l.matchAll(usageRe)) {
        if (inVerbatim(model, lineStart + m.index!)) continue
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
  model: ReferenceModel,
  position: Position,
  context: ReferenceContext,
): Location[] | null {
  const target = siteAt(model, position, (site) => site.kind === 'linkref' && site.keyRange !== null)
  if (!target) return null
  return model.sites
    .filter((site) => site.kind === 'linkref' && site.key === target.key && site.keyRange && (context.includeDeclaration || !site.declaration))
    .map((site) => ({ uri, range: site.keyRange! }))
}

// ---------------------------------------------------------------------------
// Wikilink group
// ---------------------------------------------------------------------------

function resolveWikilinkGroup(
  uri: string,
  model: ReferenceModel,
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
    return collectWikilinkRefs(uri, model, page, context)
  }
  return null
}

function collectWikilinkRefs(
  uri: string,
  model: ReferenceModel,
  page: string,
  context: ReferenceContext,
): Location[] {
  const locs: Location[] = []
  const lines = model.lines

  // Optionally include the heading that this wikilink resolves to
  if (context.includeDeclaration) {
    const defLine = findHeadingLineByText(model, page)
    if (defLine !== null) {
      locs.push(lineLocation(uri, defLine, 0, lines[defLine]?.length ?? 0))
    }
  }

  // Collect all [[Page]] usages naming the same page, compared exactly
  const wikilinkRe = /\[\[([^\]|#]+?)(?:[|#][^\]]*)?]]/g
  for (let i = 0; i < lines.length; i++) {
    for (const m of lines[i]!.matchAll(wikilinkRe)) {
      if (m[1]!.trim() === page && !inVerbatim(model, model.offsetAt({ line: i, character: m.index! }))) {
        locs.push(lineLocation(uri, i, m.index!, m.index! + m[0].length))
      }
    }
  }

  return locs
}

function findHeadingLineByText(model: ReferenceModel, targetText: string): number | null {
  if (!model.doc) return null
  const heading = findHeading(model.doc, (candidate) => headingPlainText(candidate.children) === targetText)
  if (!heading || !heading.pos) return null
  return heading.pos.startLine - 1
}

function headingPlainText(nodes: InlineNode[]): string {
  let out = ''
  for (const node of nodes) {
    if (node.type === 'text') out += node.value
    else if ('children' in node && Array.isArray(node.children)) {
      out += headingPlainText(node.children as InlineNode[])
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
