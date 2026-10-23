import { carveToHtml } from '@markup-carve/carve'
import { CodeActionKind, type CodeAction, type Diagnostic, type TextEdit } from 'vscode-languageserver-types'

/** Safe, local rewrites for diagnostics emitted by lintCarve. */
export function lintCodeActions(uri: string, source: string, diagnostics: Diagnostic[]): CodeAction[] {
  const lines = source.replace(/\r\n?/g, '\n').split('\n')
  const actions: CodeAction[] = []
  let rendered: string | undefined
  const original = () => (rendered ??= carveToHtml(lines.join('\n')))
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
    } else if (code === 'continuation-marker-refused') {
      const lineNo = diagnostic.range.start.line
      const at = diagnostic.range.start.character
      if (line[at] === '+') {
        const escaped = [...lines]
        escaped[lineNo] = `${line.slice(0, at)}\\${line.slice(at)}`
        // The refused marker already reads as text; the escape only states that.
        if (original() === carveToHtml(escaped.join('\n'))) {
          edit = { range: point(lineNo, at), newText: '\\' }
          title = 'Escape the + as literal text'
        }
      }
    } else if (code === 'list-marker-below-content-column') {
      actions.push(...markerColumnActions(uri, line, diagnostic, 'marker'))
    } else if (code === 'description-separator-below-content-column') {
      actions.push(...markerColumnActions(uri, line, diagnostic, 'separator'))
    } else if (code === 'consumed-key-near-miss') {
      const fix = nearMissEdit(lines, diagnostic)
      if (fix) ({ edit, title } = fix)
    } else if (code === 'table-alignment-run-padding') {
      // The run the diagnostic covers, not the first one on the line.
      const marker = [...line.matchAll(/\|=?[<>~^v]{1,2}(?=\S)/g)]
        .find((run) => run.index! <= diagnostic.range.start.character && run.index! + run[0].length >= diagnostic.range.end.character)
      if (marker) {
        const character = marker.index! + marker[0].length
        edit = { range: point(diagnostic.range.start.line, character), newText: ' ' }
        title = 'Terminate the table alignment run with a space'
      }
    } else if (code === 'unresolved-footnote') {
      const match = /\[\^([^\]]+)\]/.exec(line.slice(diagnostic.range.start.character)) ?? /\[\^([^\]]+)\]/.exec(line)
      if (match) {
        edit = appendBlock(source, `[^${match[1]}]: `)
        title = `Create footnote definition “${match[1]}”`
      }
    } else if (code === 'unresolved-reference-link') {
      const match = /\]\[([^\]]+)\]/.exec(line.slice(diagnostic.range.start.character)) ?? /\]\[([^\]]+)\]/.exec(line)
      if (match && match[1]) {
        edit = appendBlock(source, `[${match[1]}]: `)
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

/**
 * The two moves the engine's message names: indent to the content column to
 * nest, or outdent to the item's own column. The columns come from that message,
 * so a reworded message offers nothing rather than a guess.
 */
function markerColumnActions(uri: string, line: string, diagnostic: Diagnostic, what: 'marker' | 'separator'): CodeAction[] {
  const nest = /Indent it to column (\d+)/.exec(diagnostic.message)
  const level = /start it at column (\d+)/.exec(diagnostic.message)
  const at = diagnostic.range.start.character
  if (!nest || line.slice(0, at).includes('\t')) return []
  const lineNo = diagnostic.range.start.line
  const actions: CodeAction[] = []
  const move = (title: string, column: number, isPreferred: boolean) => {
    let edit: TextEdit | null = null
    if (column > at) edit = { range: point(lineNo, at), newText: ' '.repeat(column - at) }
    else if (column < at && /^ +$/.test(line.slice(column, at))) {
      edit = { range: { start: { line: lineNo, character: column }, end: { line: lineNo, character: at } }, newText: '' }
    }
    if (edit) actions.push({ title, kind: CodeActionKind.QuickFix, diagnostics: [diagnostic], isPreferred, edit: { changes: { [uri]: [edit] } } })
  }
  if (what === 'separator') move(`Indent the separator to column ${nest[1]} to continue the list`, Number(nest[1]), true)
  else move(`Indent the marker to column ${nest[1]} to nest it`, Number(nest[1]), true)
  if (level) move(`Outdent the marker to column ${level[1]} to end the nesting`, Number(level[1]), false)
  return actions
}

/** The near-miss key sits on the attribute lines directly above the block the finding covers. */
function nearMissEdit(lines: string[], diagnostic: Diagnostic): { edit: TextEdit; title: string } | null {
  const match = /^"([^"]+)" is not a consumed key here; did you mean \{([^}]+)\}\?/.exec(diagnostic.message)
  if (!match) return null
  const [, wrong, right] = match as unknown as [string, string, string]
  const word = new RegExp(`(?<=[{\\s])${wrong.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}(?=[\\s=}])`, 'g')
  const hits: Array<{ line: number; character: number }> = []
  for (let line = diagnostic.range.start.line; line >= 0; line--) {
    const text = lines[line] ?? ''
    if (!/^\s*(?:>\s*)*\{.*\}\s*$/.test(text)) {
      if (line < diagnostic.range.start.line) break
      continue
    }
    // Blank quoted values, keeping offsets, so only keys and bare words match.
    const keys = text.replace(/"(?:[^"\\]|\\.)*"/g, (quoted) => ' '.repeat(quoted.length))
    for (const hit of keys.matchAll(word)) hits.push({ line, character: hit.index! })
  }
  if (hits.length !== 1) return null
  const { line, character } = hits[0]!
  return {
    edit: { range: { start: { line, character }, end: { line, character: character + wrong.length } }, newText: right },
    title: `Change "${wrong}" to "${right}"`,
  }
}

/** Appends a block at the end, after a blank line so it cannot join a trailing paragraph. */
function appendBlock(source: string, block: string): TextEdit {
  const lines = source.replace(/\r\n?/g, '\n').split('\n')
  const line = Math.max(0, lines.length - 1)
  const eol = source.includes('\r\n') ? '\r\n' : '\n'
  const blanks = lines.length > 1 && (lines.at(-1) ?? '') === '' ? (lines.length > 2 && lines.at(-2)!.trim() === '' ? 0 : 1) : 2
  return { range: point(line, lines[line]?.length ?? 0), newText: eol.repeat(source === '' ? 0 : blanks) + block }
}

function point(line: number, character: number) {
  return { start: { line, character }, end: { line, character } }
}

function replace(line: number, end: number, newText: string): TextEdit {
  return { range: { start: { line, character: 0 }, end: { line, character: end } }, newText }
}
