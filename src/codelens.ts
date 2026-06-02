import { type CodeLens } from 'vscode-languageserver/node.js'

/**
 * A non-interactive code lens above each footnote definition showing how many
 * times it is referenced in the document. A definition with zero references is
 * dropped by the renderer, so the count doubles as a dead-footnote hint.
 */
export function codeLenses(source: string): CodeLens[] {
  const lines = source.split(/\r?\n/)

  // Count references: `[^label]` occurrences that are not a definition (`[^label]:`).
  const refCounts = new Map<string, number>()
  lines.forEach((line) => {
    for (const m of line.matchAll(/\[\^([^\]\s]+)\](?!:)/g)) {
      refCounts.set(m[1]!, (refCounts.get(m[1]!) ?? 0) + 1)
    }
  })

  const lenses: CodeLens[] = []
  lines.forEach((line, lineNo) => {
    const def = /^( {0,3})\[\^([^\]\s]+)\]:/.exec(line)
    if (!def) return
    const label = def[2]!
    const count = refCounts.get(label) ?? 0
    const start = def[1]!.length
    lenses.push({
      range: {
        start: { line: lineNo, character: start },
        end: { line: lineNo, character: start + label.length + 3 },
      },
      command: {
        title: count === 1 ? '1 reference' : `${count} references`,
        command: '',
      },
    })
  })

  return lenses
}
