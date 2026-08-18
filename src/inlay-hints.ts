import { InlayHintKind, type InlayHint, type Range } from 'vscode-languageserver/node.js'
import { parse, resolve, type BlockNode } from '@markup-carve/carve'

/** Quiet, author-value hints. Clients can disable the provider globally. */
export function inlayHints(source: string, requested?: Range): InlayHint[] {
  const hints: InlayHint[] = []
  try {
    const doc = resolve(parse(source, { positions: true }))
    walk(doc.children, (node) => {
      if (node.type !== 'heading' || !node.pos || !node.attrs?.id) return
      const line = node.pos.startLine - 1
      if (requested && (line < requested.start.line || line > requested.end.line)) return
      const lines = source.replace(/\r\n?/g, '\n').split('\n')
      const text = lines[line] ?? ''
      // An authored id is already visible; the useful hint is the generated one.
      if (text.includes(`{#${node.attrs.id}`) || (lines[line - 1] ?? '').includes(`#${node.attrs.id}`)) return
      hints.push({
        position: { line, character: text.length },
        label: `  #${node.attrs.id}`,
        kind: InlayHintKind.Type,
        paddingLeft: true,
        tooltip: 'Generated heading id',
      })
    })
  } catch {
    return []
  }
  return hints
}

function walk(nodes: BlockNode[], visit: (node: BlockNode) => void): void {
  for (const node of nodes) {
    visit(node)
    if ('children' in node && Array.isArray(node.children)) walk(node.children.filter(isBlock), visit)
  }
}

function isBlock(value: unknown): value is BlockNode {
  return Boolean(value && typeof value === 'object' && 'type' in value)
}
