import { type Location, type Position } from 'vscode-languageserver-types'
import { resolve, type Document, type InlineNode } from '@markup-carve/carve'
import { astColumnToCharacter, sourceLines } from './position.js'
import { smartPunctuationText } from './inline-text.js'
import { captionTargetById } from './captions.js'
import { includeDefinitionAt } from './include-definition.js'
import { resolveIncludes, type IncludeOptions } from './includes.js'
import { portableIncludePaths } from './include-paths.js'
import { walkNodes } from './ast-walk.js'
import { implicitKey, inVerbatim, referenceModel, siteAt, type ReferenceModel } from './reference-sites.js'

/**
 * Go-to-definition for Carve constructs:
 *
 * - Cross-reference  `</#id>`         -> the heading whose generated id is `id`,
 *                                       or the captioned host carrying it
 * - Fragment link    `[text](#id)`     -> same (href starts with `#`)
 * - Footnote ref     `[^name]`         -> the `[^name]:` definition line
 * - Link reference   `[text][ref]`     -> the `[ref]:` definition line
 * - Collapsed ref    `[Heading][]`     -> the heading, when no `[Heading]:` is defined
 * - Citation         `[@key]`          -> the `[@key]:` definition line
 * - Wikilink         `[[Page]]`        -> heading whose text matches Page (best-effort)
 */
export function definitionAt(
  uri: string,
  source: string,
  position: Position,
  includes?: IncludeOptions,
): Location | null {
  const included = includeDefinitionAt(source, position, includes)
  if (included) return included
  const model = referenceModel(source)
  const lines = model.lines
  const line = lines[position.line] ?? ''
  if (inVerbatim(model, model.offsetAt(position))) return null

  // 1. Citation [@key] - check before link-ref so `[@foo]` doesn't match as link-ref
  const citationTarget = resolveCitationAt(model, line, position)
  if (citationTarget !== null) return locationAtLine(uri, citationTarget)

  // 2. Cross-reference </#id>, fragment link [text](#id), or a collapsed
  //    [Heading][] with no matching definition
  const crossref = siteAt(model, position, (site) => site.kind === 'heading' && !site.declaration)
  if (crossref) {
    const local = crossref.implicit ? headingLocation(uri, source, model, crossref.key, crossref.label) : findHeadingById(uri, source, model, crossref.key)
    if (local) return local
    // 2b. The same reference, satisfied by a heading an include contributed.
    return resolveCrossrefAcrossSeam(source, crossref.key, includes)
  }

  // 3. Footnote reference [^name]
  const footnote = siteAt(model, position, (site) => site.kind === 'footnote')
  if (footnote) {
    const target = model.sites.find((site) => site.kind === 'footnote' && site.declaration && site.key === footnote.key)
    return target ? locationAtLine(uri, target.range.start.line) : null
  }

  // 4. Link reference [text][ref] or collapsed [ref][]
  const linkref = siteAt(model, position, (site) => site.kind === 'linkref' && !site.declaration)
  if (linkref) {
    const target = model.sites.find((site) => site.kind === 'linkref' && site.declaration && site.key === linkref.key)
    return target ? locationAtLine(uri, target.range.start.line) : null
  }

  // 5. Wikilink [[Page]] (the Wikilinks extension)
  const wikilinkTarget = resolveWikilinkAt(uri, source, model, line, position)
  if (wikilinkTarget !== null) return wikilinkTarget

  return null
}

// ---------------------------------------------------------------------------
// Citation: [@key] or [text; @key] -- navigate to the [@key]: definition line
// ---------------------------------------------------------------------------

function resolveCitationAt(model: ReferenceModel, line: string, position: Position): number | null {
  const lines = model.lines
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
    const keyRe = /-?@([\p{L}\p{N}_.:+-]+)/gu
    for (const km of inner.matchAll(keyRe)) {
      // offset of key label relative to full match
      const keyAbsStart = start + 1 + km.index! + 1 // skip '[' then '-?' then '@'
      const keyAbsEnd = keyAbsStart + km[1]!.length
      if (position.character < start + 1 + km.index! || position.character > keyAbsEnd) continue
      const key = km[1]!
      // Find [@key]: definition line
      return findCitationDef(model, lines, key)
    }
  }
  return null
}

function findCitationDef(model: ReferenceModel, lines: string[], key: string): number | null {
  const defRe = new RegExp(`^ {0,3}\\[@${escapeRegExp(key)}\\]:`)
  let offset = 0
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i]!
    if (defRe.test(line) && !inVerbatim(model, offset + line.indexOf('['))) return i
    offset += line.length + 1
  }
  return null
}

// ---------------------------------------------------------------------------
// Cross-reference: </#id> or [text](#id) -> heading
// ---------------------------------------------------------------------------

/**
 * A crossref whose target an INCLUDE contributes.
 *
 * Resolved through the merged document rather than by searching each child's
 * own source, because the id the author writes is the id the MERGE produced: a
 * child heading whose explicit id the parent had already claimed is renamed
 * (§19 I5), and a child pulled in by `#section` contributes only part of
 * itself. Searching child sources would answer for the file on disk and miss
 * both.
 *
 * The location is the child's `watch` path, never its id. An id is whatever
 * the resolver chose, and a virtual-filesystem resolver can return one that
 * looks like a path and opens nothing.
 */
function resolveCrossrefAcrossSeam(
  source: string,
  targetId: string,
  includes: IncludeOptions | undefined,
): Location | null {
  if (!includes?.resolver) return null

  const resolution = resolveIncludes(source, includes)
  if (!resolution.expanded) return null
  // Resolved after the merge, so a heading carries the id the whole document
  // gives it: a slug is generated against the merged content, and an explicit
  // id the merge renamed is already renamed here.
  let merged: Document
  try {
    merged = resolve(resolution.expanded)
  } catch {
    return null
  }
  // A crossref reaches a CAPTIONED HOST as well - a figure, a table, a
  // composite figure or one of its panels (PART 9R R4) - and reaches it in the
  // open document already. An include seam that resolved only headings would
  // make the target model depend on which file the host sits in.
  const pos =
    findHeadingWithId(merged, targetId)?.pos ??
    captionTargetById(merged, targetId)?.pos
  if (!pos || pos.file === undefined) return null

  const child = resolution.documents.find((document) => document.id === pos.file)
  if (child?.watch === undefined) return null

  const childLine = pos.startLine - 1
  return {
    uri: (includes.paths ?? portableIncludePaths).toUri(child.watch),
    range: {
      start: { line: childLine, character: 0 },
      end: {
        line: childLine,
        character:
          pos.endColumn === undefined
            ? 199
            : astColumnToCharacter(sourceLines(child.source)[childLine] ?? '', pos.endColumn),
      },
    },
  }
}

function findHeadingById(uri: string, source: string, model: ReferenceModel, targetId: string): Location | null {
  const doc = model.doc
  if (!doc) return null
  const heading = headingLocation(uri, source, model, targetId)
  if (!heading) {
    // A crossref reaches a CAPTIONED HOST as well - a figure, a table, a
    // composite figure or one of its panels (PART 9R R4). Only headings were
    // searched here, so `</#fig>` jumped nowhere on a construct that predates
    // composite figures entirely.
    return findCaptionById(uri, doc, targetId)
  }
  return heading
}

/** `text`, when given, is a collapsed reference's label, which must spell the heading's text exactly. */
function headingLocation(uri: string, source: string, model: ReferenceModel, targetId: string, text?: string): Location | null {
  const heading = model.doc ? findHeadingWithId(model.doc, targetId) : null
  if (!heading?.pos) return null
  if (text !== undefined && implicitKey(headingPlainText(heading.children)) !== implicitKey(text)) return null
  const line = heading.pos.startLine - 1
  return {
    uri,
    range: {
      start: { line, character: 0 },
      // The heading's end column counts codepoints; the range carries UTF-16
      // code units. Without a column at all, 200 stands in for "the whole
      // line", as it did before.
      end: {
        line,
        character:
          heading.pos.endColumn === undefined
            ? 199
            : astColumnToCharacter(sourceLines(source)[line] ?? '', heading.pos.endColumn),
      },
    },
  }
}

/**
 * The host's own first line. A captioned host has no single "definition line"
 * the way a heading does - its id sits on a block-attribute line above it, its
 * caption below it - so the jump lands on the host itself, which is the line an
 * author is looking for.
 */
function findCaptionById(uri: string, doc: Document, targetId: string): Location | null {
  const target = captionTargetById(doc, targetId)
  if (!target?.pos) return null
  return locationAtLine(uri, target.pos.startLine - 1)
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

function findHeadingWithId(doc: Document, targetId: string): Heading | null {
  return findHeading(doc, (heading) => heading.attrs?.id === targetId)
}

// ---------------------------------------------------------------------------
// Wikilink [[Page]] -> heading whose text matches Page
// ---------------------------------------------------------------------------

function resolveWikilinkAt(uri: string, source: string, model: ReferenceModel, line: string, position: Position): Location | null {
  const wikilinkRe = /\[\[([^\]|#]+?)(?:[|#][^\]]*)?]]/g
  for (const m of line.matchAll(wikilinkRe)) {
    const start = m.index!
    const end = start + m[0].length
    if (position.character < start || position.character >= end) continue
    const page = m[1]!.trim()
    return findHeadingByText(uri, source, model, page)
  }
  return null
}

function findHeadingByText(uri: string, source: string, model: ReferenceModel, text: string): Location | null {
  if (!model.doc) return null
  const heading = findHeading(model.doc, (candidate) => headingPlainText(candidate.children) === text)
  if (!heading || !heading.pos) return null

  const line = heading.pos.startLine - 1
  return {
    uri,
    range: {
      start: { line, character: 0 },
      // The heading's end column counts codepoints; the range carries UTF-16
      // code units. Without a column at all, 200 stands in for "the whole
      // line", as it did before.
      end: {
        line,
        character:
          heading.pos.endColumn === undefined
            ? 199
            : astColumnToCharacter(sourceLines(source)[line] ?? '', heading.pos.endColumn),
      },
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
    // An inline literal (§27) renders as visible prose, so it must contribute
    // to the heading text a crossref resolves against.
    else if (node.type === 'literal_inline') out += node.content
    else out += smartPunctuationText(node)
  }
  return out.trim()
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
