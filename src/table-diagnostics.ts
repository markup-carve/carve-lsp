import { DiagnosticSeverity, type Diagnostic } from 'vscode-languageserver-types'
import { walkNodes } from './ast-walk.js'
import { ownStartLine, tableRows } from './tree.js'
import { resolvedDocument } from './parse-cache.js'

/**
 * The draft #1344 table check the engine lint does not run: a positional
 * attribute with more entries than the table has columns. Padding, short
 * arity, width totals and overlap come from the engine. Tables are read from
 * the AST, so fenced, commented and quoted text is handled as the parser reads it.
 */
export function tableDiagnostics(source: string): Diagnostic[] {
  let document: unknown
  try {
    document = resolvedDocument(source)
  } catch {
    return []
  }
  const diagnostics: Diagnostic[] = []
  const lines = source.replace(/\r\n?/g, '\n').split('\n')
  walkNodes(document, (node) => {
    if (node.type !== 'table' || !node.pos?.startLine) return
    const rows = tableRows(node)
    const columns = Math.max(0, ...rows.map((row) => row.cells?.length ?? 0))
    // A 0.2 table span starts at the attribute lines it took (C2-A-148), so those lines are its own.
    for (let attrLine = node.pos.startLine - 1; attrLine < ownStartLine(node.pos, lines); attrLine += 1) {
      for (const attr of positionalAttributes(lines[attrLine] ?? '')) {
        if (attr.values.length > columns) {
          diagnostics.push(diagnostic('table-column-arity', DiagnosticSeverity.Error, attrLine,
            attr.start, attr.end, `${attr.name} has ${attr.values.length} entries for a ${columns}-column table.`))
        }
      }
    }
    return false
  })
  return diagnostics
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
