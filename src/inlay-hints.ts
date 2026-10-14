import { InlayHintKind, type InlayHint, type Range } from 'vscode-languageserver-types'
import type { Heading } from '@markup-carve/carve'
import { walkNodes } from './ast-walk.js'
import { resolvedDocument } from './parse-cache.js'
import { sourceLines } from './position.js'

/** Quiet, author-value hints. Clients can disable the provider globally. */
export function inlayHints(source: string, requested?: Range): InlayHint[] {
  const hints: InlayHint[] = []
  try {
    const doc = resolvedDocument(source)
    const lines = sourceLines(source)
    walkNodes([doc.children, doc.footnoteDefs], (found) => {
      if (found.type === 'paragraph') return false
      if (found.type !== 'heading') return
      const node = found as unknown as Heading
      if (!node.pos || !node.attrs?.id) return false
      const line = node.pos.startLine - 1
      if (requested && (line < requested.start.line || line > requested.end.line)) return false
      const text = lines[line] ?? ''
      // An authored id is already visible; the useful hint is the generated one.
      if (text.includes(`{#${node.attrs.id}`) || (lines[line - 1] ?? '').includes(`#${node.attrs.id}`)) return false
      hints.push({
        position: { line, character: text.length },
        label: `  #${node.attrs.id}`,
        kind: InlayHintKind.Type,
        paddingLeft: true,
        tooltip: 'Generated heading id',
      })
      return false
    })
  } catch {
    return []
  }
  return hints.sort((a, b) => a.position.line - b.position.line)
}
