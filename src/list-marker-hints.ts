import type { InlayHint, Range } from 'vscode-languageserver/node.js'
import type { TextDocumentContentChangeEvent } from 'vscode-languageserver-textdocument'
import { bareMarkerItem } from './list-items.js'

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
 * marker belongs to a list (`bareMarkerItem`), so a lone `- ` in prose and a
 * marker the author walked away from stay unhinted. The marker may sit after
 * a container prefix (`> - `, a footnote or description body).
 */
export function bareListMarkerHints(source: string, line: number | undefined, requested?: Range): InlayHint[] {
  if (line === undefined) return []
  if (requested && (line < requested.start.line || line > requested.end.line)) return []
  const text = source.split(/\r\n|\r|\n/)[line]
  if (text === undefined || !/ $/.test(text)) return []
  const item = bareMarkerItem(source, line, text)
  const bare = item ? BARE_MARKER.exec(text.slice(item.character)) : null
  if (!bare) return []
  return [{
    position: { line, character: text.length },
    label: bare[2] ? 'task' : 'list item',
    tooltip: 'A list marker needs content after it; until then this line is paragraph text.',
  }]
}
