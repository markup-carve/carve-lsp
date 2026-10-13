import {
  CompletionItemKind,
  type CompletionItem,
  type Position,
} from 'vscode-languageserver-types'
import { parse, resolve, type BlockNode, type Document } from '@markup-carve/carve'
import { captionTargets, type CaptionTarget } from './captions.js'
import type { IndexedToken } from './workspace-index.js'

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

/** The six kinds that place generated content (PART 12, the engine's GENERATED_CONTENT_KINDS). */
const PLACEMENT_MARKERS = ['toc', 'footnotes', 'references', 'bibliography', 'glossary', 'index']

/** Container extensions: Tier-2 (corpus-pinned) and code-group (Tier-3). `tab` is a panel inside `tabs`. */
const EXTENSION_CONTAINERS = ['details', 'spoiler', 'tabs', 'tab', 'list-table', 'code-group']

/** The non-word container openers: fenced block quote, line block, hard-break block. */
const SYMBOL_CONTAINERS = [
  { value: '>', detail: 'Fenced block quote' },
  { value: '|', detail: 'Line block' },
  { value: '\\', detail: 'Hard-break block' },
]

/** Fence languages worth offering; any word is valid. */
const CODE_LANGUAGES = ['bash', 'c', 'carve', 'cpp', 'csharp', 'css', 'diff', 'go', 'html', 'java', 'javascript', 'json',
  'kotlin', 'markdown', 'php', 'python', 'ruby', 'rust', 'shell', 'sql', 'swift', 'text', 'toml', 'typescript', 'xml', 'yaml']
/** Languages an extension renders instead of printing as code. */
const RENDERED_LANGUAGES = ['math', 'mermaid', 'svg']
const RAW_FORMATS = ['=html', '=latex']

/**
 * Context-aware completions driven by the text immediately before the cursor:
 *   - `::: ` opens a container   -> canonical admonition kinds, and `figure`
 *   - `</#`  cross-reference     -> heading ids in the document
 *   - `[^`   footnote reference  -> defined footnote labels
 *   - `][`   reference link      -> defined link reference labels
 */
export interface CompletionContext {
  workspaceTokens?: IndexedToken[]
}

export function completionAt(source: string, position: Position, context: CompletionContext = {}): CompletionItem[] {
  const line = source.split(/\r?\n/)[position.line] ?? ''
  const prefix = line.slice(0, position.character)

  let match: RegExpExecArray | null
  if ((match = /:::\s*([\w-]*)$/.exec(prefix))) {
    return [
      ...ADMONITIONS.map((kind) =>
        completion(kind, CompletionItemKind.Keyword, match![1], position, 'Admonition kind'),
      ),
      completion(FIGURE_GROUP, CompletionItemKind.Struct, match![1], position, 'Composite figure'),
      ...PLACEMENT_MARKERS.map((kind) => completion(kind, CompletionItemKind.Constant, match![1], position, 'Placement marker')),
      ...EXTENSION_CONTAINERS.map((kind) => completion(kind, CompletionItemKind.Struct, match![1], position, 'Extension container')),
      ...(match[1] === '' && /\s$/.test(prefix)
        ? SYMBOL_CONTAINERS.map(({ value, detail }) => completion(value, CompletionItemKind.Operator, '', position, detail))
        : []),
    ]
  }
  if ((match = /^(?:[ \t]*>)*[ \t]*(?:`{3,}|~{3,})[ \t]?(=?[\w+#.-]*)$/.exec(prefix)) && !insideCodeBlock(source, position.line)) {
    const partial = match[1]!
    if (partial.startsWith('=')) return RAW_FORMATS.map((format) => completion(format, CompletionItemKind.Value, partial, position, 'Raw format'))
    return [
      ...CODE_LANGUAGES.map((language) => completion(language, CompletionItemKind.Value, partial, position, 'Code language')),
      ...RENDERED_LANGUAGES.map((language) => completion(language, CompletionItemKind.Value, partial, position, 'Code language, rendered by an extension')),
      ...RAW_FORMATS.map((format) => completion(format, CompletionItemKind.Value, partial, position, 'Raw format')),
    ]
  }
  if ((match = /<\/#([\w-]*)$/.exec(prefix))) {
    // A crossref reaches a captioned host as well as a heading (PART 9R R4).
    // Offering only heading ids said the others were not targets, which is the
    // reading that made a `</#fig>` naming a figure look like a typo.
    const workspace = (context.workspaceTokens ?? [])
      .filter((token) => token.declaration && (token.kind === 'heading' || token.kind === 'caption'))
      .map((token) => completion(token.key, CompletionItemKind.Reference, match![1], position, `${token.kind} in workspace`))
    return uniqueCompletions([
      ...headingIds(source).map((id) =>
        completion(id, CompletionItemKind.Reference, match![1], position, 'Heading id'),
      ),
      ...resolvableCaptionIds(source).map(({ id, detail }) =>
        completion(id, CompletionItemKind.Reference, match![1], position, detail),
      ),
      ...workspace,
    ])
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
  if ((match = /\[@([\w:.-]*)$/.exec(prefix))) {
    const local = citationLabels(source)
    const workspace = (context.workspaceTokens ?? [])
      .filter((token) => token.declaration && token.kind === 'citation')
      .map((token) => token.key)
    return [...new Set([...local, ...workspace])].map((label) =>
      completion(label, CompletionItemKind.Reference, match![1], position, 'Citation key'))
  }
  // Inside `{{ ... }}` the include completions own the slot; nothing below applies.
  if (prefix.lastIndexOf('{{') > prefix.lastIndexOf('}}')) return []
  // `[My` with a heading `# My Head`: complete the collapsed reference `[My Head][]`.
  if ((match = /(?:^|[^![\\\]])\[([^\s\]\[^@][^\][]*)$/.exec(prefix))) {
    const partial = match[1]!
    const closing = line[position.character] === ']' ? 1 : 0
    return headingTitles(source)
      .filter((title) => title.toLowerCase().startsWith(partial.toLowerCase()))
      .map((title) => {
        const item = completion(title, CompletionItemKind.Reference, partial, position, 'Heading link')
        item.textEdit = { range: { start: { line: position.line, character: position.character - partial.length }, end: { line: position.line, character: position.character + closing } }, newText: `${title}][]` }
        item.filterText = title
        return item
      })
  }
  // The partial is the token after the block's last space, so `{.cl` replaces `.cl`.
  if ((match = /\{(?:[^}\n]*\s)?([#.]?[\w-]*)$/.exec(prefix))) {
    const attributes = ['#id', '.class', 'align=', 'valign=', 'width=', 'aligns=', 'valigns=', 'widths=',
      'header-rows=', 'header-cols=', 'footer-rows=', 'start=', 'type=', 'title=', 'label=']
    return attributes.map((attribute) =>
      completion(attribute, CompletionItemKind.Property, match![1], position, 'Carve attribute'))
  }
  if ((match = /:(\w*)$/.exec(prefix))) {
    return ['abbr', 'time', 'kbd', 'samp', 'var', 'cite', 'dfn'].map((name) =>
      completion(name, CompletionItemKind.TypeParameter, match![1], position, 'Semantic span'))
  }
  return []
}

function uniqueCompletions(items: CompletionItem[]): CompletionItem[] {
  const seen = new Set<string>()
  return items.filter((item) => {
    if (seen.has(item.label)) return false
    seen.add(item.label)
    return true
  })
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

/** Zero-based `line` lies inside a code or raw block that opened on an earlier line. */
function insideCodeBlock(source: string, line: number): boolean {
  let found = false
  const walk = (value: unknown): void => {
    if (found) return
    if (Array.isArray(value)) { value.forEach(walk); return }
    if (!value || typeof value !== 'object') return
    const node = value as { type?: string; pos?: { startLine?: number; endLine?: number } }
    const { startLine, endLine } = node.pos ?? {}
    if ((node.type === 'code_block' || node.type === 'raw_block') && startLine !== undefined && endLine !== undefined && startLine < line + 1 && line + 1 <= endLine) found = true
    for (const [name, child] of Object.entries(value)) if (name !== 'pos' && name !== 'attrs') walk(child)
  }
  try {
    walk(parse(source, { positions: true }).children)
  } catch {
    return false
  }
  return found
}

/** Heading texts as a collapsed reference `[Text][]` must spell them. */
function headingTitles(source: string): string[] {
  const titles: string[] = []
  const text = (nodes: unknown): string => Array.isArray(nodes)
    ? nodes.map((node: { value?: unknown; children?: unknown; type?: string }) => node.type === 'soft_break' ? ' ' : typeof node.value === 'string' ? node.value : text(node.children)).join('')
    : ''
  try {
    walkBlocks(parse(source).children, (node) => {
      if (node.type === 'heading') titles.push(text(node.children).trim())
    })
  } catch {
    return []
  }
  return [...new Set(titles.filter((title) => title !== ''))]
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

function citationLabels(source: string): string[] {
  const labels = new Set<string>()
  for (const line of source.split(/\r?\n/)) {
    const match = /^\s{0,3}\[@([^\]]+)\]:/.exec(line)
    if (match) labels.add(match[1]!)
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
