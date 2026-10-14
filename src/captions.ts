import {
  type BlockNode,
  type Document,
  type InlineNode,
  type Position as SourcePosition,
} from '@markup-carve/carve'
import { smartPunctuationText } from './inline-text.js'
import { walkNodes } from './ast-walk.js'

/**
 * The captioned hosts a `</#id>` can name, and the text each one resolves to.
 *
 * The server used to walk HEADINGS for every crossref feature, so a `</#fig>`
 * naming a captioned figure - a construct that predates composite figures -
 * offered no completion, jumped nowhere and hovered as if the `#` inside it
 * opened a section. This is the other half of the crossref target set (PART 9R
 * R4): `figure`, `table`, `figure_group`, and a group's PANELS.
 *
 * WHERE THE NUMBER COMES FROM. Not from here. A numbered caption carries a
 * `caption_number` node whose `n` the engine already resolved, so the text is
 * assembled from the caption the author wrote up to and including that node -
 * "Figure 2" out of `^ Figure #: Group caption`. Re-deriving the sequence would
 * be a second copy of PART 9R R5, and the two would drift the first time a
 * label sequence changed.
 *
 * The PANEL LETTER is the one thing derived here, because no engine API exposes
 * it: panel order among the panels only, a..z then aa, ab (PART 9 §4c). The
 * tests pin it against the anchor text `carveToHtml` writes for the same id, so
 * the derivation is measured against the engine rather than against a reading
 * of the clause.
 */
export interface CaptionTarget {
  /** The authored id, as written. */
  id: string
  /** What the host is, for a completion label and a hover heading. */
  kind: 'figure' | 'table' | 'composite figure' | 'panel'
  /**
   * The text a `</#id>` resolves to - "Figure 2", "Figure 2a", "Table 1" - or
   * null when the host drew no number. §4c: an unnumbered group's panels are
   * anchors but not caption crossref targets, and the same has always been true
   * of an id on an uncaptioned figure.
   */
  text: string | null
  /** The host's own span, for go-to-definition and find-references. */
  pos: SourcePosition | undefined
}

/** Every captioned host in the document that carries an id, in source order. */
export function captionTargets(doc: Document): CaptionTarget[] {
  const targets: CaptionTarget[] = []
  const panels = new Set<unknown>()
  // Every container is walked, list items and footnote bodies included: a
  // captioned figure there is a crossref target like any other.
  walkNodes(doc, (node) => {
    const block = node as unknown as BlockNode
    if (panels.has(node)) return
    if (block.type === 'figure_group') {
      const groupText = captionRefText(block.caption)
      pushTarget(targets, block, 'composite figure', groupText)
      collectPanels(block, groupText, targets, panels)
    } else if (block.type === 'figure') {
      pushTarget(targets, block, 'figure', captionRefText(block.caption))
    } else if (block.type === 'table') {
      pushTarget(targets, block, 'table', captionRefText(block.caption))
    }
  })
  return targets
}

/** The target an id names, or null. Ids compare exactly. */
export function captionTargetById(doc: Document, id: string): CaptionTarget | null {
  return captionTargets(doc).find((target) => target.id === id) ?? null
}

/**
 * The letter a panel takes in crossref text: a..z, then aa, ab, ... (§4c).
 *
 * Bijective base-26, not base-26 with a zero digit: the panel after `z` is `aa`,
 * so 26 must not carry as `ba`.
 */
export function panelLetter(index: number): string {
  let out = ''
  let n = index
  do {
    out = String.fromCharCode(97 + (n % 26)) + out
    n = Math.floor(n / 26) - 1
  } while (n >= 0)
  return out
}

/**
 * A group's panels are its DIRECT `figure` and `table` children, in source
 * order (§4c). Everything else in the body is plain group content: it can still
 * hold crossref targets of its own, but it draws no letter and does not shift
 * the letters of the panels around it.
 */
function collectPanels(
  group: Extract<BlockNode, { type: 'figure_group' }>,
  groupText: string | null,
  targets: CaptionTarget[],
  panels: Set<unknown>,
): void {
  let panelIndex = 0
  for (const child of group.children) {
    if (child.type !== 'figure' && child.type !== 'table') continue
    panels.add(child)
    pushTarget(
      targets,
      child,
      'panel',
      groupText === null ? null : `${groupText}${panelLetter(panelIndex)}`,
    )
    panelIndex++
  }
}

function pushTarget(
  targets: CaptionTarget[],
  node: BlockNode,
  kind: CaptionTarget['kind'],
  text: string | null,
): void {
  const id = (node as { attrs?: { id?: string } }).attrs?.id
  if (!id) return
  targets.push({ id, kind, text, pos: node.pos })
}

/**
 * The crossref text a caption yields: everything up to and including its
 * `caption_number`, trimmed. A caption with no number yields null - there is
 * nothing for `</#id>` to render, and the engine leaves such a reference as
 * literal text.
 */
function captionRefText(caption: readonly InlineNode[] | undefined): string | null {
  if (!caption) return null
  let out = ''
  for (const node of caption) {
    if (node.type === 'caption_number') {
      const n = (node as { n?: number }).n
      if (typeof n !== 'number') return null
      return `${out}${n}`.trim()
    }
    out += plainText([node])
  }
  return null
}

function plainText(nodes: readonly InlineNode[]): string {
  let out = ''
  for (const node of nodes) {
    if (node.type === 'text') out += node.value
    else if ('children' in node && Array.isArray(node.children)) {
      out += plainText(node.children as InlineNode[])
    } else if (node.type === 'code') out += node.value
    else if (node.type === 'literal_inline') out += node.content
    else out += smartPunctuationText(node)
  }
  return out
}
