import { carveToCarve, carveToHtml, parse } from '@markup-carve/carve'
import { CodeAction, CodeActionKind, Range, TextEdit } from 'vscode-languageserver-types'
import { walkNodes } from './ast-walk.js'
import { tableDisplayWidth } from './table-display-width.js'

function splitRow(line: string): { marker: string, cells: string[], attrs: string } | null {
  const marker = line[0]
  if (marker !== '|' && marker !== '+') return null
  const cells: string[] = []
  let start = 1
  let codeRun = 0
  for (let index = 1; index < line.length; index++) {
    if (line[index] === '`') {
      if (codeRun === 0) {
        let slashes = 0
        for (let previous = index - 1; previous >= start && line[previous] === '\\'; previous--) slashes++
        if (slashes % 2 !== 0) continue
      }
      let end = index + 1
      while (line[end] === '`') end++
      const length = end - index
      if (codeRun === 0 && hasClosingRun(line, end, length)) codeRun = length
      else if (codeRun === length) codeRun = 0
      index = end - 1
      continue
    }
    if (line[index] !== '|') continue
    if (codeRun !== 0) continue
    let slashes = 0
    for (let previous = index - 1; previous >= start && line[previous] === '\\'; previous--) slashes++
    if (slashes % 2 !== 0) continue
    cells.push(line.slice(start, index))
    start = index + 1
  }
  if (cells.length === 0) return null
  return { marker, cells, attrs: line.slice(start) }
}

function hasClosingRun(line: string, from: number, length: number): boolean {
  for (let index = from; index < line.length; index++) {
    if (line[index] !== '`') continue
    let end = index + 1
    while (line[end] === '`') end++
    if (end - index === length) return true
    index = end - 1
  }
  return false
}

function alignCanonicalTable(source: string): string {
  const lines = source.replace(/\n$/, '').split('\n')
  const rows = lines.map(splitRow)
  const widths: number[] = []
  for (const row of rows) row?.cells.forEach((cell, index) => {
    widths[index] = Math.max(widths[index] ?? 0, tableDisplayWidth(cell))
  })
  const aligned = lines.map((line, index) => {
    const row = rows[index]
    return row ? row.marker + row.cells.map((cell, column) =>
      cell + ' '.repeat(widths[column]! - tableDisplayWidth(cell))).join('|') + '|' + row.attrs : line
  }).join('\n') + '\n'
  return carveToHtml(source) === carveToHtml(aligned) ? aligned : source
}

export interface TableAlignmentEdit {
  startLine: number
  endLine: number
  startOffset: number
  endOffset: number
  textEdit: TextEdit
}

export function tableAlignmentEdits(source: string, firstLine = 0, lastLine = Number.MAX_SAFE_INTEGER): TableAlignmentEdit[] {
  try {
    return findTableAlignmentEdits(source, firstLine, lastLine)
  } catch {
    return []
  }
}

function findTableAlignmentEdits(source: string, firstLine: number, lastLine: number): TableAlignmentEdit[] {
  const parts = source.split(/(\r\n|\n|\r)/)
  const lines: { text: string, eol: string, start: number }[] = []
  let offset = 0
  for (let index = 0; index < parts.length; index += 2) {
    const text = parts[index] ?? ''
    const eol = parts[index + 1] ?? ''
    lines.push({ text, eol, start: offset })
    offset += text.length + eol.length
  }
  const edits: TableAlignmentEdit[] = []
  walkNodes(parse(source, { positions: true }), node => {
    if (node.type !== 'table' || node.pos?.startLine === undefined || node.pos.endLine === undefined || node.pos.startColumn === undefined) return
    const startLine = node.pos.startLine - 1
    const endLine = node.pos.endLine - 1
    if (endLine < firstLine || startLine > lastLine) return false
    const original = lines.slice(startLine, endLine + 1)
    const prefixLength = node.pos.startColumn - 1
    const prefixes = original.map(line => line.text.slice(0, prefixLength))
    if (original.length === 0 || original.some(line => line.text.length < prefixLength)) return false
    const bare = original.map(line => line.text.slice(prefixLength)).join('\n') + '\n'
    const canonical = carveToCarve(bare)
    const formatted = carveToHtml(bare) === carveToHtml(canonical) ? alignCanonicalTable(canonical) : bare
    const renderedLines = formatted.replace(/\n$/, '').split('\n')
    if (renderedLines.length !== original.length) return false
    const replaced = renderedLines.map((line, index) => prefixes[index] + line +
      (index < renderedLines.length - 1 ? (original[index]?.eol ?? original[0]!.eol) || '\n' : '')).join('')
    const startOffset = original[0]!.start
    const endOffset = original.at(-1)!.start + original.at(-1)!.text.length
    if (replaced === source.slice(startOffset, endOffset)) return false
    edits.push({
      startLine,
      endLine,
      startOffset,
      endOffset,
      textEdit: TextEdit.replace(Range.create(startLine, 0, endLine, lines[endLine]!.text.length), replaced),
    })
    return false
  })
  return edits.sort((a, b) => a.startLine - b.startLine)
}

export function alignTablesInDocument(source: string): string {
  const edits = tableAlignmentEdits(source)
  if (edits.length === 0) return source
  let result = source
  for (const edit of edits.reverse()) {
    result = result.slice(0, edit.startOffset) + edit.textEdit.newText + result.slice(edit.endOffset)
  }
  return result
}

export function alignTableCodeAction(uri: string, source: string, line: number): CodeAction | null {
  const edit = tableAlignmentEdits(source, line, line)[0]
  if (!edit) return null
  return {
    title: 'Align table',
    kind: CodeActionKind.RefactorRewrite,
    edit: { changes: { [uri]: [edit.textEdit] } },
  }
}
