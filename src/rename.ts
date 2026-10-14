import { type Position, type Range, type WorkspaceEdit } from 'vscode-languageserver-types'
import { referenceModel, siteAt, type ReferenceModel, type ReferenceSite } from './reference-sites.js'

/** Footnote and link-reference labels the parser read, with the range of the label text. */
function labelSites(model: ReferenceModel): ReferenceSite[] {
  return model.sites.filter((site) => (site.kind === 'footnote' || site.kind === 'linkref') && site.keyRange !== null)
}

function labelAt(model: ReferenceModel, position: Position): ReferenceSite | null {
  const site = siteAt(model, position, (candidate) => (candidate.kind === 'footnote' || candidate.kind === 'linkref') && candidate.keyRange !== null)
  return site && contains(site.keyRange!, position) ? site : null
}

/** Validate the cursor sits on a renameable label; return its range + text. */
export function prepareRename(
  source: string,
  position: Position,
): { range: Range; placeholder: string } | null {
  const model = referenceModel(source)
  const site = labelAt(model, position)
  if (!site) return null
  const range = site.keyRange!
  const line = model.lines[range.start.line] ?? ''
  return { range, placeholder: line.slice(range.start.character, range.end.character) }
}

/** Rename every occurrence of the label under the cursor (within its kind). */
export function renameEdits(
  uri: string,
  source: string,
  position: Position,
  newName: string,
): WorkspaceEdit | null {
  const model = referenceModel(source)
  const target = labelAt(model, position)
  if (!target) return null
  const trimmed = newName.trim()
  // Labels cannot contain brackets or whitespace, and a link label cannot open like a footnote or citation.
  if (trimmed === '' || /[[\]\s]/.test(trimmed)) return null
  if (target.kind === 'linkref' && /^[@^]/.test(trimmed)) return null

  const edits = labelSites(model)
    .filter((site) => site.kind === target.kind && site.key === target.key)
    .map((site) => ({ range: site.keyRange!, newText: trimmed }))

  return { changes: { [uri]: edits } }
}

function contains(range: Range, position: Position): boolean {
  return position.line === range.start.line && position.character >= range.start.character && position.character <= range.end.character
}
