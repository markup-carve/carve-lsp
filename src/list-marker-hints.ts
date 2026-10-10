import type { InlayHint, Range } from 'vscode-languageserver/node.js'
import type { TextDocumentContentChangeEvent } from 'vscode-languageserver-textdocument'
import { parse, type Document, type Position } from '@markup-carve/carve'

// A marker and its separator alone on a line. The separator is spaces (a tab
// makes the line text), roman numerals are single-case, and only bullets carry
// a task box.
const BARE_MARKER = /^[ \t]*(?:([-*]) +(\[ \] +)?|(?:\.|(?:[0-9]+|[A-Za-z]|[ivxlcdm]+|[IVXLCDM]+)[.)]) +)$/

/**
 * The zero-based line the last change in a didChange batch ended on, in the
 * document as it stands after the batch. A full-text replacement says nothing
 * about where the author is typing, so it yields undefined.
 */
export function editedLine(changes: readonly TextDocumentContentChangeEvent[]): number | undefined {
  const last = changes[changes.length - 1]
  if (!last || !('range' in last)) return undefined
  return last.range.start.line + (last.text.match(/\r\n|\r|\n/g)?.length ?? 0)
}

/**
 * Ghost text after a content-less list marker: such a marker is paragraph
 * text until content lands. Only the line just edited, and only when the
 * previous non-blank line belongs to a list item, so a lone `- ` in prose and
 * a marker the author walked away from stay unhinted.
 */
export function bareListMarkerHints(source: string, line: number | undefined, requested?: Range): InlayHint[] {
  if (line === undefined) return []
  if (requested && (line < requested.start.line || line > requested.end.line)) return []
  const lines = source.split(/\r\n|\r|\n/)
  const text = lines[line]
  const bare = text === undefined ? null : BARE_MARKER.exec(text)
  if (!bare) return []
  let previous = line - 1
  while (previous >= 0 && lines[previous]!.trim() === '') previous--
  if (previous < 0) return []
  const context = listContext(source)
  if (!context || context.code.has(line) || !context.items.has(previous)) return []
  return [{
    position: { line, character: text!.length },
    label: bare[2] ? 'task' : 'list item',
    tooltip: 'A list marker needs content after it; until then this line is paragraph text.',
  }]
}

function listContext(source: string): { items: Set<number>; code: Set<number> } | null {
  let doc: Document
  try {
    doc = parse(source, { positions: true })
  } catch {
    return null
  }
  const items = new Set<number>()
  const code = new Set<number>()
  const visit = (value: unknown): void => {
    if (Array.isArray(value)) {
      for (const entry of value) visit(entry)
      return
    }
    if (value === null || typeof value !== 'object') return
    const node = value as { type?: unknown; pos?: Position; block?: unknown }
    const pos = node.pos
    if (pos?.startLine !== undefined && pos.endLine !== undefined) {
      if (node.type === 'code_block' || node.type === 'raw_block' || (node.type === 'comment' && node.block === true)) {
        for (let n = pos.startLine - 1; n < pos.endLine; n++) code.add(n)
        return
      }
      if (node.type === 'list_item') for (let n = pos.startLine - 1; n < pos.endLine; n++) items.add(n)
    }
    for (const key of Object.keys(node)) if (key !== 'pos') visit((node as Record<string, unknown>)[key])
  }
  // The whole document, so lists in footnote bodies (doc.footnoteDefs) count too.
  visit(doc)
  return { items, code }
}
