import {
  CompletionItemKind,
  type CompletionItem,
  type Position,
} from 'vscode-languageserver/node.js'
import { parse, resolve, type BlockNode, type Document } from '@markup-carve/carve'
import { captionTargets, type CaptionTarget } from './captions.js'

/** The eight canonical admonition kinds (grammar PART 9 §12, Tier 1). */
const ADMONITIONS = ['note', 'tip', 'warning', 'danger', 'info', 'success', 'example', 'quote']

/**
 * `figure` is not one of them. It is RESERVED among the `:::` types (PART 9
 * §4c): a BARE `::: figure` opener is one figure of ordered panels, and the same
 * word with a title or a `[label]` is an ordinary container. Offering it beside
 * the eight would say it is a ninth admonition, so it is offered separately and
 * labelled for what it opens.
 */
const FIGURE_GROUP = 'figure'

/**
 * Context-aware completions driven by the text immediately before the cursor:
 *   - `::: ` opens a container   -> canonical admonition kinds, and `figure`
 *   - `</#`  cross-reference     -> heading ids in the document
 *   - `[^`   footnote reference  -> defined footnote labels
 *   - `][`   reference link      -> defined link reference labels
 */
export function completionAt(source: string, position: Position): CompletionItem[] {
  const line = source.split(/\r?\n/)[position.line] ?? ''
  const prefix = line.slice(0, position.character)

  let match: RegExpExecArray | null
  if ((match = /:::\s*([\w-]*)$/.exec(prefix))) {
    return [
      ...ADMONITIONS.map((kind) =>
        completion(kind, CompletionItemKind.Keyword, match![1], position, 'Admonition kind'),
      ),
      completion(FIGURE_GROUP, CompletionItemKind.Struct, match![1], position, 'Composite figure'),
    ]
  }
  if ((match = /<\/#([\w-]*)$/.exec(prefix))) {
    // A crossref reaches a captioned host as well as a heading (PART 9R R4).
    // Offering only heading ids said the others were not targets, which is the
    // reading that made a `</#fig>` naming a figure look like a typo.
    return [
      ...headingIds(source).map((id) =>
        completion(id, CompletionItemKind.Reference, match![1], position, 'Heading id'),
      ),
      ...resolvableCaptionIds(source).map(({ id, detail }) =>
        completion(id, CompletionItemKind.Reference, match![1], position, detail),
      ),
    ]
  }
  if ((match = /\[\^([\w-]*)$/.exec(prefix))) {
    return footnoteLabels(source).map((label) =>
      completion(label, CompletionItemKind.Reference, match![1], position, 'Footnote'),
    )
  }
  if ((match = /\]\[([\w-]*)$/.exec(prefix))) {
    return linkReferenceLabels(source).map((label) =>
      completion(label, CompletionItemKind.Reference, match![1], position, 'Link reference'),
    )
  }
  return []
}

function completion(
  value: string,
  kind: CompletionItemKind,
  partial: string,
  position: Position,
  detail: string,
): CompletionItem {
  return {
    label: value,
    kind,
    detail,
    // Replace the partial token the user already typed so values containing
    // `-` or `#` are not mangled by the editor's default word range.
    textEdit: {
      range: {
        start: { line: position.line, character: position.character - partial.length },
        end: position,
      },
      newText: value,
    },
  }
}

function headingIds(source: string): string[] {
  const ids: string[] = []
  try {
    const doc = resolve(parse(source))
    walkBlocks(doc.children, (node) => {
      if (node.type === 'heading' && node.attrs?.id) ids.push(node.attrs.id)
    })
  } catch {
    // Parsing may fail mid-edit; offer no ids rather than throwing.
  }
  return [...new Set(ids)]
}

/**
 * The caption ids a `</#…>` can actually RESOLVE, each with what it resolves to
 * - "Figure 2" beside "Figure 2a", so the list distinguishes a group from its
 * panels without the author having to remember which is which.
 *
 * A host that drew NO number is left out. Its id is a real anchor, and a
 * `[text](#id)` fragment link reaches it, but a CROSSREF to it renders as
 * literal text (PART 9 §4c: an unnumbered group's panels are anchors, not
 * caption crossref targets). Every heading id this list offers resolves, and a
 * caption id that did not would be the one entry that quietly does not work.
 */
function resolvableCaptionIds(source: string): Array<{ id: string; detail: string }> {
  let targets: CaptionTarget[]
  try {
    targets = captionTargets(resolve(parse(source, { positions: true })))
  } catch {
    // Parsing may fail mid-edit; offer no ids rather than throwing.
    return []
  }
  const resolvable: Array<{ id: string; detail: string }> = []
  for (const target of targets) {
    if (target.text === null) continue
    resolvable.push({ id: target.id, detail: `${target.text} (${target.kind})` })
  }
  return resolvable
}

function footnoteLabels(source: string): string[] {
  try {
    const doc: Document = resolve(parse(source))
    return Object.keys(doc.footnoteDefs ?? {})
  } catch {
    return []
  }
}

/** Scrape `[label]: url` reference definitions straight from the source. */
function linkReferenceLabels(source: string): string[] {
  const labels = new Set<string>()
  for (const line of source.split(/\r?\n/)) {
    const match = /^\s{0,3}\[([^\]]+)\]:\s+\S/.exec(line)
    // `[^label]:` is a footnote definition, not a link reference definition.
    if (match && !match[1]!.startsWith('^')) labels.add(match[1]!)
  }
  return [...labels]
}

function walkBlocks(nodes: BlockNode[], visit: (node: BlockNode) => void): void {
  for (const node of nodes) {
    visit(node)
    if ('children' in node && Array.isArray(node.children)) {
      walkBlocks(node.children.filter(isBlockNode), visit)
    }
  }
}

function isBlockNode(node: unknown): node is BlockNode {
  return Boolean(node && typeof node === 'object' && 'type' in node)
}
