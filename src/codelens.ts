import { type CodeLens } from 'vscode-languageserver-types'
import { scanDocument } from './workspace-index.js'

/**
 * A non-interactive code lens above each declaration showing how many times it
 * is referenced in the document. A footnote with zero references is dropped by
 * the renderer, so its count doubles as a dead-footnote hint.
 */
export function codeLenses(source: string): CodeLens[] {
  const tokens = scanDocument('file:///document.crv', source)
  const lenses: CodeLens[] = []
  for (const declaration of tokens) {
    if (!declaration.declaration) continue
    const count = tokens.filter((token) =>
      !token.declaration && token.kind === declaration.kind && token.key === declaration.key).length
    // A footnote lens spans the whole `[^label]` marker.
    const range = declaration.kind === 'footnote'
      ? {
          start: { line: declaration.range.start.line, character: declaration.range.start.character - 2 },
          end: { line: declaration.range.end.line, character: declaration.range.end.character + 1 },
        }
      : declaration.range
    lenses.push({ range, command: { title: count === 1 ? '1 reference' : `${count} references`, command: '' } })
  }
  return lenses
}
