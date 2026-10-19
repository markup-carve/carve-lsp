import { carveToHtml, parse } from '@markup-carve/carve'
import { CodeAction, CodeActionKind, Range, TextEdit } from 'vscode-languageserver-types'
import { walkNodes, type AstNode } from './ast-walk.js'
import { alignCanonicalTable } from './table-alignment.js'

type Cell = AstNode & { header?: boolean; children?: AstNode[] }
type Row = AstNode & { cells?: Cell[]; footer?: boolean }
type Table = AstNode & { rows?: Row[]; sourceFormat?: string }
export interface ConversionEdit { startOffset: number; endOffset: number; textEdit: TextEdit; newText: string }

function cells(source: string): string[][][] {
  const result: string[][][] = []
  walkNodes(parse(source), node => {
    if (node.type === 'table') {
      result.push(((node as Table).rows ?? []).map(row => (row.cells ?? []).map(cell =>
        (cell.children ?? []).filter(child => child.type === 'text' || child.type === 'escaped_text').map(child => String(child.value ?? '')).join(''))))
      return false
    }
  })
  return result
}

export function isLosslessRewrite(oldSource: string, newSource: string): boolean {
  try {
    return carveToHtml(oldSource) === carveToHtml(newSource) && JSON.stringify(cells(oldSource)) === JSON.stringify(cells(newSource))
  } catch { return false }
}

const TABLE_FLAG = /^\{(?:[^{}]*\s)?table(?:\s[^{}]*)?\}$/

function linesOf(source: string): { text: string; start: number; eol: string }[] {
  const parts = source.split(/(\r\n|\n|\r)/)
  const lines: { text: string; start: number; eol: string }[] = []
  let start = 0
  for (let i = 0; i < parts.length; i += 2) {
    const text = parts[i] ?? '', eol = parts[i + 1] ?? ''
    lines.push({ text, start, eol })
    start += text.length + eol.length
  }
  return lines
}

function selected(source: string, line: number, format: 'csv' | 'pipe'): { table: Table; lines: ReturnType<typeof linesOf>; first: number; last: number; attrs: string | null } | null {
  const lines = linesOf(source)
  let found: ReturnType<typeof selected> = null
  walkNodes(parse(source, { positions: true }), node => {
    if (node.type !== 'table' || !node.pos?.startLine || !node.pos.endLine) return
    const table = node as Table
    if (format === 'csv' ? !['csv', 'tsv'].includes(table.sourceFormat ?? '') : !!table.sourceFormat) return false
    const start = node.pos.startLine - 1, last = node.pos.endLine - 1
    const previous = lines[start - 1]?.text ?? ''
    const hasAttrs = format === 'csv' ? TABLE_FLAG.test(previous) : /^\{[^{}]*\}$/.test(previous) && !TABLE_FLAG.test(previous)
    const first = hasAttrs ? start - 1 : start
    if (line >= first && line <= last && node.pos.startColumn === 1 && lines.slice(start, last + 1).every(item => !/^\s/.test(item.text))) {
      found = { table, lines, first, last, attrs: hasAttrs ? previous : null }
      return false
    }
    return false
  })
  return found
}

function finish(source: string, info: NonNullable<ReturnType<typeof selected>>, rendered: string): ConversionEdit | null {
  const { lines, first, last } = info
  const eol = lines[first]?.eol || source.match(/\r\n|\n|\r/)?.[0] || '\n'
  const newText = rendered.replace(/\n/g, eol)
  const startOffset = lines[first]!.start
  const endOffset = lines[last]!.start + lines[last]!.text.length
  const replacement = source.slice(0, startOffset) + newText + source.slice(endOffset)
  if (!isLosslessRewrite(source, replacement)) return null
  return { startOffset, endOffset, newText, textEdit: TextEdit.replace(Range.create(first, 0, last, lines[last]!.text.length), newText) }
}

function value(cell: Cell): string {
  return (cell.children ?? []).map(child => String(child.value ?? '')).join('')
}

const ESCAPE_TIERS = [/[\\|]/g, /[\\|*_`{}\[\]<>^~=+!%$"'\-.:#&@/]/g, /[!-/:-@[-`{-~]/g]

function isPlainCell(cell: Cell): boolean {
  return (cell.children ?? []).every(child => child.type === 'text' || child.type === 'escaped_text')
}

// Lightest escaping whose one-cell parse gives back the field as plain text; the document guard still decides.
function escapeField(field: string, minimum: number): string {
  for (let tier = minimum; tier < ESCAPE_TIERS.length; tier++) {
    const escaped = field.replace(ESCAPE_TIERS[tier]!, character => '\\' + character)
    if (tier === ESCAPE_TIERS.length - 1) return escaped
    const cell = ((parse(`| ${escaped} |\n`).children?.[0] as Table | undefined)?.rows?.[0]?.cells ?? [])
    if (cell.length === 1 && isPlainCell(cell[0]!) && value(cell[0]!).trim() === field.trim()) return escaped
  }
  return field
}

export function csvTableToPipe(source: string, line: number): ConversionEdit | null {
  try {
    const info = selected(source, line, 'csv')
    if (!info) return null
    const rows = info.table.rows ?? []
    if (rows.some(row => (row.cells ?? []).some(cell => /[\r\n]/.test(value(cell))))) return null
    const caption = info.lines[info.last]?.text.startsWith('^ ') ? '\n' + info.lines[info.last]!.text : ''
    const attrs = info.attrs?.slice(1, -1).split(/\s+/).filter(token => token !== '' && token !== 'table').join(' ')
    const attrLine = attrs ? `{${attrs}}\n` : ''
    for (const minimum of [0, ESCAPE_TIERS.length - 1]) {
      const bare = rows.map(row => '|'+ (row.cells ?? []).map(cell =>
        `${cell.header ? '=' : ''} ${escapeField(value(cell), minimum)} `).join('|') + '|').join('\n') + '\n'
      const aligned = alignCanonicalTable(bare).trimEnd()
      const edit = finish(source, info, attrLine + aligned + caption)
      if (edit) return edit
    }
    return null
  } catch { return null }
}

function csvField(field: string): string {
  return /[,"\r\n]|^\s|\s$/.test(field) ? '"' + field.replace(/"/g, '""') + '"' : field
}

export function pipeTableToCsv(source: string, line: number): ConversionEdit | null {
  try {
    const info = selected(source, line, 'pipe')
    if (!info) return null
    const rows = info.table.rows ?? []
    if (rows.length === 0 || rows.some(row => !row.cells?.length || row.cells.some(cell =>
      !!cell.attrs || !!cell.colspan || !!cell.rowspan || !!cell.colSpan || !!cell.rowSpan ||
      !isPlainCell(cell)))) return null
    const headers = rows.filter(row => row.cells!.every(cell => cell.header)).length
    if (rows.some((row, index) => row.cells!.some(cell => !!cell.header !== (index < headers)))) return null
    if (rows.some(row => row.footer)) return null
    const extras = headers === 0 ? 'header-rows=0' : headers > 1 ? `header-rows=${headers}` : ''
    const attrContent = info.attrs ? info.attrs.slice(1, -1).trim() : ''
    const attrs = `{table${attrContent || extras ? ' ' + [attrContent, extras].filter(Boolean).join(' ') : ''}}`
    const fields = rows.map(row => row.cells!.map(cell => value(cell)))
    const maxRun = Math.max(2, ...fields.flat().flatMap(field => [...field.matchAll(/`+/g)].map(match => match[0].length)))
    const fence = '`'.repeat(maxRun + 1)
    const caption = info.lines[info.last]?.text.startsWith('^ ') ? '\n' + info.lines[info.last]!.text : ''
    const rendered = `${attrs}\n${fence}csv\n${fields.map(row => row.map(csvField).join(',')).join('\n')}\n${fence}${caption}`
    return finish(source, info, rendered)
  } catch { return null }
}

export function tableConversionCodeActions(uri: string, source: string, line: number): CodeAction[] {
  try {
    const conversion = csvTableToPipe(source, line)
    if (conversion) return [{ title: 'Convert to pipe table', kind: CodeActionKind.RefactorRewrite, edit: { changes: { [uri]: [conversion.textEdit] } } }]
    const reverse = pipeTableToCsv(source, line)
    return reverse ? [{ title: 'Convert to CSV table', kind: CodeActionKind.RefactorRewrite, edit: { changes: { [uri]: [reverse.textEdit] } } }] : []
  } catch { return [] }
}
