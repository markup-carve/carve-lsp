import { type Position, type Range, type WorkspaceEdit } from 'vscode-languageserver/node.js'

type LabelKind = 'footnote' | 'linkref'

interface LabelToken {
  kind: LabelKind
  label: string
  line: number
  startChar: number
  endChar: number
}

/**
 * Collect renameable label tokens (footnote labels and link-reference labels)
 * with the source range of the label text itself (excluding brackets).
 */
function collectTokens(source: string): LabelToken[] {
  const tokens: LabelToken[] = []
  const lines = source.split(/\r?\n/)

  lines.forEach((line, lineNo) => {
    // Footnote references and definitions share the `[^label]` form.
    for (const m of line.matchAll(/\[\^([^\]\s]+)\]/g)) {
      const start = m.index! + 2
      tokens.push({ kind: 'footnote', label: m[1]!, line: lineNo, startChar: start, endChar: start + m[1]!.length })
    }
    // Link reference definition at line start: `[label]: url` (not a footnote).
    const def = /^( {0,3})\[([^\]]+)\]:/.exec(line)
    if (def && !def[2]!.startsWith('^')) {
      const start = def[1]!.length + 1
      tokens.push({ kind: 'linkref', label: def[2]!, line: lineNo, startChar: start, endChar: start + def[2]!.length })
    }
    // Link reference use: `][label]` (collapsed or full reference link).
    // Labels may contain spaces (`[text][my label]`); `^`-prefixed is a footnote.
    for (const m of line.matchAll(/\]\[([^\]]+)\]/g)) {
      if (m[1]!.startsWith('^')) continue
      const start = m.index! + 2
      tokens.push({ kind: 'linkref', label: m[1]!, line: lineNo, startChar: start, endChar: start + m[1]!.length })
    }
  })

  return tokens
}

function tokenAt(source: string, position: Position): LabelToken | null {
  for (const token of collectTokens(source)) {
    if (
      token.line === position.line &&
      position.character >= token.startChar &&
      position.character <= token.endChar
    ) {
      return token
    }
  }
  return null
}

function tokenRange(token: LabelToken): Range {
  return {
    start: { line: token.line, character: token.startChar },
    end: { line: token.line, character: token.endChar },
  }
}

/** Validate the cursor sits on a renameable label; return its range + text. */
export function prepareRename(
  source: string,
  position: Position,
): { range: Range; placeholder: string } | null {
  const token = tokenAt(source, position)
  return token ? { range: tokenRange(token), placeholder: token.label } : null
}

/** Rename every occurrence of the label under the cursor (within its kind). */
export function renameEdits(
  uri: string,
  source: string,
  position: Position,
  newName: string,
): WorkspaceEdit | null {
  const target = tokenAt(source, position)
  if (!target) return null
  const trimmed = newName.trim()
  // Labels cannot contain brackets or whitespace.
  if (trimmed === '' || /[[\]\s]/.test(trimmed)) return null

  const edits = collectTokens(source)
    .filter((token) => token.kind === target.kind && token.label === target.label)
    .map((token) => ({ range: tokenRange(token), newText: trimmed }))

  return { changes: { [uri]: edits } }
}
