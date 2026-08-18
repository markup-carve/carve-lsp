import { DocumentHighlightKind, type DocumentHighlight, type Position } from 'vscode-languageserver/node.js'
import { scanDocument } from './workspace-index.js'

export function documentHighlights(uri: string, source: string, position: Position): DocumentHighlight[] {
  const tokens = scanDocument(uri, source)
  const target = tokens.find((token) =>
    token.range.start.line === position.line &&
    position.character >= token.range.start.character &&
    position.character <= token.range.end.character)
  if (!target) return []
  return tokens
    .filter((token) => token.kind === target.kind && token.key.toLocaleLowerCase() === target.key.toLocaleLowerCase())
    .map((token) => ({
      range: token.range,
      kind: token.declaration ? DocumentHighlightKind.Write : DocumentHighlightKind.Read,
    }))
}
