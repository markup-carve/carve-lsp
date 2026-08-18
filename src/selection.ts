import { type Position, type Range, type SelectionRange } from 'vscode-languageserver/node.js'
import { scanDocument } from './workspace-index.js'

export function selectionRanges(uri: string, source: string, positions: Position[]): SelectionRange[] {
  const lines = source.replace(/\r\n?/g, '\n').split('\n')
  const tokens = scanDocument(uri, source)
  return positions.map((position) => {
    const lineText = lines[position.line] ?? ''
    const lineRange: Range = {
      start: { line: position.line, character: 0 },
      end: { line: position.line, character: lineText.length },
    }
    const documentRange: Range = {
      start: { line: 0, character: 0 },
      end: { line: Math.max(0, lines.length - 1), character: lines.at(-1)?.length ?? 0 },
    }
    const parent: SelectionRange = { range: lineRange, parent: { range: documentRange } }
    const token = tokens.find((candidate) => contains(candidate.range, position))
    if (token) return { range: token.range, parent }
    const word = wordRange(lineText, position)
    return word ? { range: word, parent } : parent
  })
}

function contains(range: Range, position: Position): boolean {
  return position.line === range.start.line && position.character >= range.start.character && position.character <= range.end.character
}

function wordRange(line: string, position: Position): Range | null {
  for (const match of line.matchAll(/[\p{L}\p{N}_-]+/gu)) {
    const start = match.index!
    const end = start + match[0].length
    if (position.character >= start && position.character <= end) {
      return { start: { line: position.line, character: start }, end: { line: position.line, character: end } }
    }
  }
  return null
}
