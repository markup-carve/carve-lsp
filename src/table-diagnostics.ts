import { DiagnosticSeverity, type Diagnostic } from 'vscode-languageserver/node.js'

/** Draft #1344 diagnostics kept local until the pinned engine ships their lint producers. */
export function tableDiagnostics(source: string): Diagnostic[] {
  const diagnostics: Diagnostic[] = []
  const lines = source.replace(/\r\n?/g, '\n').split('\n')
  for (let line = 0; line < lines.length; line += 1) {
    const text = lines[line]!
    if (!/^\s*\|/.test(text)) continue
    for (const match of text.matchAll(/\|=?[<>~^v]{1,2}(?=\S)/g)) {
      diagnostics.push(diagnostic('table-alignment-run-padding', DiagnosticSeverity.Warning, line,
        match.index!, match.index! + match[0].length,
        'A table alignment run needs a terminating space; this spelling is literal content.'))
    }

    if (line > 0 && /^\s*\|/.test(lines[line - 1] ?? '')) continue
    let end = line
    while (end + 1 < lines.length && /^\s*\|/.test(lines[end + 1] ?? '')) end += 1
    const columns = Math.max(...lines.slice(line, end + 1).map(columnCount), 0)
    const attrLine = lines[line - 1] ?? ''
    const attrs = positionalAttributes(attrLine)
    for (const attr of attrs) {
      if (attr.values.length > columns) {
        diagnostics.push(diagnostic('table-column-arity', DiagnosticSeverity.Error, line - 1,
          attr.start, attr.end, `${attr.name} has ${attr.values.length} entries for a ${columns}-column table.`))
      } else if (attr.values.length < columns) {
        diagnostics.push(diagnostic('table-column-arity', DiagnosticSeverity.Warning, line - 1,
          attr.start, attr.end, `${attr.name} leaves ${columns - attr.values.length} trailing column(s) unset.`))
      }
      if (attr.name === 'widths') {
        const total = attr.values.reduce((sum, value) => sum + (Number(value) || 0), 0)
        if (total > 100) diagnostics.push(diagnostic('table-width-total', DiagnosticSeverity.Warning, line - 1,
          attr.start, attr.end, `Column widths total ${total}%, overcommitting the table.`))
      }
    }
    const aligns = attrs.find((attr) => attr.name === 'aligns')
    if (aligns && /\|=?[<>~>]/.test(text)) {
      diagnostics.push(diagnostic('table-column-overlap', DiagnosticSeverity.Warning, line - 1,
        aligns.start, aligns.end, 'An in-table horizontal alignment marker overrides this table attribute.'))
    }
    line = end
  }
  return diagnostics
}

function columnCount(line: string): number {
  const pipes = [...line.matchAll(/(?<!\\)\|/g)].length
  return Math.max(0, pipes - 1)
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
    start: { line: Math.max(0, line), character: start },
    end: { line: Math.max(0, line), character: end },
  } }
}
