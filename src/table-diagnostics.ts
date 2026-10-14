import { DiagnosticSeverity, type Diagnostic } from 'vscode-languageserver-types'
import { parse } from '@markup-carve/carve'
import { walkNodes, type AstNode } from './ast-walk.js'

/**
 * The draft #1344 table check the engine lint does not run: a positional
 * attribute with more entries than the table has columns. Padding, short
 * arity, width totals and overlap come from the engine. Tables are read from
 * the AST, so fenced, commented and quoted text is handled as the parser reads it.
 */
export function tableDiagnostics(source: string): Diagnostic[] {
  let document: unknown
  try {
    document = parse(source, { positions: true })
  } catch {
    return []
  }
  const diagnostics: Diagnostic[] = []
  const lines = source.replace(/\r\n?/g, '\n').split('\n')
  walkNodes(document, (node) => {
    if (node.type !== 'table' || !node.pos?.startLine || !Array.isArray(node.rows)) return
    const attrLine = node.pos.startLine - 2
    if (attrLine < 0) return
    const rows = node.rows as Array<{ cells?: unknown[] }>
    const columns = Math.max(0, ...rows.map((row) => row.cells?.length ?? 0))
    for (const attr of positionalAttributes(lines[attrLine] ?? '').filter((entry) => keyed(node, entry.name))) {
      if (attr.values.length > columns) {
        diagnostics.push(diagnostic('table-column-arity', DiagnosticSeverity.Error, attrLine,
          attr.start, attr.end, `${attr.name} has ${attr.values.length} entries for a ${columns}-column table.`))
      }
    }
    return false
  })
  return diagnostics
}

/** The table's own attribute block carries `name`, so a match on its line is not stray text. */
function keyed(table: AstNode, name: string): boolean {
  const attrs = table.attrs as { keyValues?: Record<string, unknown> } | undefined
  return attrs?.keyValues?.[name] !== undefined
}

function positionalAttributes(line: string): Array<{ name: string; values: string[]; start: number; end: number }> {
  const attrs: Array<{ name: string; values: string[]; start: number; end: number }> = []
  for (const match of line.matchAll(/\b(aligns|valigns|widths)=(?:"([^"]*)"|'([^']*)'|([^\s}]+))/g)) {
    const raw = match[2] ?? match[3] ?? match[4] ?? ''
    attrs.push({ name: match[1]!, values: raw.split(','), start: match.index!, end: match.index! + match[0].length })
  }
  return attrs
}

function diagnostic(
  code: string, severity: DiagnosticSeverity, line: number, start: number, end: number, message: string,
): Diagnostic {
  return { code, severity, source: 'carve', message, range: {
    start: { line, character: start },
    end: { line, character: end },
  } }
}
