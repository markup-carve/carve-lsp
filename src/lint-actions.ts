import { CodeActionKind, type CodeAction, type Diagnostic, type TextEdit } from 'vscode-languageserver/node.js'

/** Safe, local rewrites for diagnostics emitted by lintCarve. */
export function lintCodeActions(uri: string, source: string, diagnostics: Diagnostic[]): CodeAction[] {
  const lines = source.replace(/\r\n?/g, '\n').split('\n')
  const actions: CodeAction[] = []
  for (const diagnostic of diagnostics) {
    const code = String(diagnostic.code ?? '')
    const line = lines[diagnostic.range.start.line] ?? ''
    let edit: TextEdit | null = null
    let title = ''
    if (code === 'raw-block-syntax') {
      const match = /^(\s*`{3,})raw(?: +([^\s]+))?/.exec(line)
      if (match) {
        const replacement = `${match[1]}=${match[2] ?? 'html'}`
        edit = replace(diagnostic.range.start.line, match[0].length, replacement)
        title = 'Convert to a Carve raw fence'
      }
    } else if (code === 'blockquote-marker-without-space') {
      const marker = /^\s*>/.exec(line)
      if (marker) {
        const character = marker[0].length
        edit = { range: point(diagnostic.range.start.line, character), newText: ' ' }
        title = 'Insert the block-quote separator'
      }
    } else if (code === 'table-alignment-run-padding') {
      const marker = /\|=?[<>~^v]{1,2}(?=\S)/.exec(line)
      if (marker) {
        const character = marker.index + marker[0].length
        edit = { range: point(diagnostic.range.start.line, character), newText: ' ' }
        title = 'Terminate the table alignment run with a space'
      }
    } else if (code === 'unresolved-footnote') {
      const match = /\[\^([^\]]+)\]/.exec(line.slice(diagnostic.range.start.character)) ?? /\[\^([^\]]+)\]/.exec(line)
      if (match) {
        edit = append(source, `\n[^${match[1]}]: `)
        title = `Create footnote definition “${match[1]}”`
      }
    } else if (code === 'unresolved-reference-link') {
      const match = /\]\[([^\]]+)\]/.exec(line.slice(diagnostic.range.start.character)) ?? /\]\[([^\]]+)\]/.exec(line)
      if (match && match[1]) {
        edit = append(source, `\n[${match[1]}]: `)
        title = `Create link definition “${match[1]}”`
      }
    } else if (code === 'colon-fence-length-mismatch') {
      const authored = /^\s*(:{3,})/.exec(line)
      const expected = Number((diagnostic.data as { expectedWidth?: unknown } | undefined)?.expectedWidth)
      if (authored && Number.isInteger(expected) && expected >= 3) {
        const start = line.indexOf(authored[1]!)
        const range = { start: { line: diagnostic.range.start.line, character: start }, end: { line: diagnostic.range.start.line, character: start + authored[1]!.length } }
        actions.push({
          title: `Resize to ${expected} colons and close the container`, kind: CodeActionKind.QuickFix,
          diagnostics: [diagnostic], isPreferred: true,
          edit: { changes: { [uri]: [{ range, newText: ':'.repeat(expected) }] } },
        })
        actions.push({
          title: 'Preserve the colon run as literal text', kind: CodeActionKind.QuickFix,
          diagnostics: [diagnostic], isPreferred: false,
          edit: { changes: { [uri]: [{ range: point(diagnostic.range.start.line, start), newText: '\\' }] } },
        })
      }
    }
    if (!edit) continue
    actions.push({
      title,
      kind: CodeActionKind.QuickFix,
      diagnostics: [diagnostic],
      isPreferred: true,
      edit: { changes: { [uri]: [edit] } },
    })
  }
  return actions
}

function append(source: string, newText: string): TextEdit {
  const lines = source.replace(/\r\n?/g, '\n').split('\n')
  const line = Math.max(0, lines.length - 1)
  return { range: point(line, lines[line]?.length ?? 0), newText }
}

function point(line: number, character: number) {
  return { start: { line, character }, end: { line, character } }
}

function replace(line: number, end: number, newText: string): TextEdit {
  return { range: { start: { line, character: 0 }, end: { line, character: end } }, newText }
}
