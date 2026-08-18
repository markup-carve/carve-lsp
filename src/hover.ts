import { MarkupKind, type Hover, type Position } from 'vscode-languageserver/node.js'
import {
  parse,
  resolve,
  type BlockNode,
  type Document,
  type InlineNode,
  type Position as SourcePosition,
} from '@markup-carve/carve'
import { astColumnToCharacter, characterToAstColumn, sourceLines } from './position.js'
import { captionTargetById, type CaptionTarget } from './captions.js'

interface HoverRule {
  pattern: RegExp
  contents: string
}

const rules: HoverRule[] = [
  {
    pattern: /\|=?\s*[<>~^v]{1,2}(?=\{| )/g,
    contents: '**Table alignment**\n\nA one- or two-character run sets horizontal and/or vertical cell alignment. Two-axis runs normalize to horizontal then vertical.',
  },
  {
    pattern: /\b(?:aligns|valigns|widths|header-rows|header-cols|footer-rows)=/g,
    contents: '**Table metadata**\n\nA positional table/ListTable field. Empty list entries leave that column unset; cell-local values win.',
  },
  {
    pattern: /\[@[^\]\n]+\]/g,
    contents: '**Citation**\n\nCitation groups reference `[@key]: ...` bibliography entries when the Citations extension is enabled.',
  },
  {
    pattern: /\{\{[^}\n]+\}\}/g,
    contents: '**Include**\n\nProcessor-level file inclusion. The language server resolves it only in a trusted, explicitly enabled workspace.',
  },
  {
    pattern: /#{1,6}/g,
    contents: '**Heading**\n\n`#` through `######` create section headings.',
  },
  {
    pattern: /\*[^*\n]+\*/g,
    contents: '**Bold**\n\nCarve uses single asterisks for bold text: `*bold*`.',
  },
  {
    pattern: /\/[^/\n]+\//g,
    contents: '**Italic**\n\nCarve uses slashes for italic text: `/italic/`.',
  },
  {
    pattern: /_[^_\n]+_/g,
    contents: '**Underline**\n\nCarve uses underscores for underline: `_underlined_`.',
  },
  {
    pattern: /~[^~\n]+~/g,
    contents: '**Strikethrough**\n\nCarve uses tildes for strikethrough: `~removed~`.',
  },
  {
    pattern: /\{[^}\n]+\}/g,
    contents: '**Attributes**\n\nAttach IDs, classes, and key/value pairs with `{#id .class key=value}`.',
  },
  {
    pattern: /\[[^\]\n]+\]\([^\s)]+(?:\s+"[^"]*")?\)/g,
    contents: '**Link**\n\nInline links use `[label](url)`.',
  },
  {
    pattern: /!\[[^\]\n]*\]\([^\s)]+(?:\s+"[^"]*")?\)/g,
    contents: '**Image**\n\nImages use `![alt](url)` and can be followed by captions.',
  },
  {
    pattern: /`[^`\n]+`/g,
    contents: '**Inline Code**\n\nBackticks mark inline code spans.',
  },
]

export function hoverAt(source: string, position: Position): Hover | null {
  const lines = sourceLines(source)

  try {
    const hover = astHoverAt(resolve(parse(source)), position, lines)
    if (hover) return hover
  } catch {
    // Fall back to lexical help below for documents that do not parse.
  }

  const line = lines[position.line]
  if (line === undefined) return null

  for (const rule of rules) {
    rule.pattern.lastIndex = 0
    for (const match of line.matchAll(rule.pattern)) {
      const start = match.index ?? 0
      const end = start + match[0].length
      if (position.character < start || position.character > end) continue
      return {
        contents: {
          kind: MarkupKind.Markdown,
          value: rule.contents,
        },
        range: {
          start: { line: position.line, character: start },
          end: { line: position.line, character: end },
        },
      }
    }
  }

  return null
}

function astHoverAt(doc: Document, position: Position, lines: string[]): Hover | null {
  // The request counts UTF-16 code units and the AST may count codepoints, so
  // the cursor converts once here and every comparison below stays in the
  // parser's unit. The range converts back on the way out.
  const cursor: Position = {
    line: position.line,
    character: characterToAstColumn(lines[position.line] ?? '', position.character) - 1,
  }
  const matches: Array<{ pos: SourcePosition; contents: string }> = []
  // A crossref's help depends on what the id NAMES, so the whole document is in
  // scope for it while every other rule reads one node. It is looked up through
  // this resolver rather than from inside the inline walk.
  const resolveRef: RefResolver = (id) => captionTargetById(doc, id)
  for (const node of doc.children) collectBlock(matches, node, cursor, resolveRef)
  matches.sort((a, b) => spanSize(a.pos) - spanSize(b.pos))
  const match = matches[0]
  if (!match) return null
  return {
    contents: {
      kind: MarkupKind.Markdown,
      value: match.contents,
    },
    range: toRange(match.pos, lines),
  }
}

function collectBlock(
  matches: Array<{ pos: SourcePosition; contents: string }>,
  node: BlockNode,
  position: Position,
  resolveRef: RefResolver,
): void {
  addMatch(matches, node.pos, position, blockContents(node))
  switch (node.type) {
    case 'heading':
      collectInline(matches, node.children, position, resolveRef)
      break
    case 'paragraph':
      collectInline(matches, node.children, position, resolveRef)
      break
    case 'block_quote':
      node.children.forEach((child) => collectBlock(matches, child, position, resolveRef))
      break
    case 'list':
      node.items.forEach((item) => item.children.forEach((child) => collectBlock(matches, child, position, resolveRef)))
      break
    case 'admonition':
    case 'div':
      node.children.forEach((child) => collectBlock(matches, child, position, resolveRef))
      if (node.type === 'admonition' && node.title) collectInline(matches, node.title, position, resolveRef)
      break
    case 'definition_list':
      node.items.forEach((item) => {
        item.terms.forEach((term) => collectInline(matches, term, position, resolveRef))
        item.definitions.forEach((definition) =>
          definition.forEach((child) => collectBlock(matches, child, position, resolveRef)),
        )
      })
      break
    case 'figure':
      collectBlock(matches, node.target, position, resolveRef)
      collectInline(matches, node.caption, position, resolveRef)
      break
    case 'figure_group':
      node.children.forEach((child) => collectBlock(matches, child, position, resolveRef))
      if (node.caption) collectInline(matches, node.caption, position, resolveRef)
      break
    case 'table':
      if (node.caption) collectInline(matches, node.caption, position, resolveRef)
      node.rows.forEach((row) => row.cells.forEach((cell) => collectInline(matches, cell.children, position, resolveRef)))
      break
  }
}

function collectInline(
  matches: Array<{ pos: SourcePosition; contents: string }>,
  nodes: InlineNode[],
  position: Position,
  resolveRef: RefResolver,
): void {
  for (const node of nodes) {
    addMatch(matches, node.pos, position, inlineContents(node, resolveRef))
    const children = (node as { children?: InlineNode[] }).children
    if (Array.isArray(children)) collectInline(matches, children, position, resolveRef)
    const content = (node as { content?: InlineNode[] }).content
    if (Array.isArray(content)) collectInline(matches, content, position, resolveRef)
  }
}

function addMatch(
  matches: Array<{ pos: SourcePosition; contents: string }>,
  pos: SourcePosition | undefined,
  position: Position,
  contents: string | null,
): void {
  if (!contents || !pos || !contains(pos, position)) return
  matches.push({ pos, contents })
}

function blockContents(node: BlockNode): string | null {
  switch (node.type) {
    case 'heading':
      return '**Heading**\n\n`#` through `######` create section headings.'
    case 'code_block':
      return '**Code Block**\n\nTriple backtick or tilde fences create verbatim code blocks.'
    case 'raw_block':
      return '**Raw Block**\n\nRaw passthrough blocks render only for matching output formats.'
    case 'block_quote':
      return '**Block Quote**\n\nLines beginning with `>` create quoted blocks.'
    case 'list':
      return '**List**\n\nUse bullets, task markers, or ordered markers for lists.'
    case 'table':
      return '**Table**\n\nPipe-delimited rows create tables.'
    case 'admonition':
      return '**Admonition**\n\nTyped `:::` fences create admonition blocks.'
    case 'div':
      return '**Div**\n\nBare `:::` fences create generic container blocks.'
    case 'figure_group':
      return (
        '**Composite Figure**\n\nA bare `::: figure` fence is one figure of ordered panels. ' +
        'The `^ ` line after the closing fence captions the whole group. ' +
        'An opener carrying a title or a `[label]` stays a generic container instead.'
      )
    default:
      return null
  }
}

function inlineContents(node: InlineNode, resolveRef: RefResolver): string | null {
  switch (node.type) {
    case 'strong':
      return '**Bold**\n\nCarve uses single asterisks for bold text: `*bold*`.'
    case 'emphasis':
      return '**Italic**\n\nCarve uses slashes for italic text: `/italic/`.'
    case 'underline':
      return '**Underline**\n\nCarve uses underscores for underline: `_underlined_`.'
    case 'strike':
      return '**Strikethrough**\n\nCarve uses tildes for strikethrough: `~removed~`.'
    case 'subscript':
      return '**Subscript**\n\nCarve subscript uses the braced form `{,text,}`, e.g. `H{,2,}O`. A bare comma is literal text.'
    case 'superscript':
      return '**Superscript**\n\nCarve superscript uses the braced form `{^text^}`, e.g. `E=mc{^2^}`. A bare caret is literal text.'
    case 'highlight':
      return '**Highlight**\n\nCarve highlight is a single equals: `=marked=` (use the forced form `{=marked=}` intraword).'
    case 'code':
      return '**Inline Code**\n\nBackticks mark inline code spans.'
    case 'literal_inline':
      return '**Inline Literal**\n\nA `!` prefix on a verbatim span renders its content as ordinary prose, without code styling: `` !`/kaet/` ``. Mirrors the `$`-math prefix.'
    case 'link':
      return '**Link**\n\nInline links use `[label](url)` or reference-link syntax.'
    case 'image':
      return '**Image**\n\nImages use `![alt](url)` and can be followed by captions.'
    case 'mention':
      return '**Mention**\n\nMentions use `@name`.'
    case 'tag':
      return '**Tag**\n\nTags use `#name`.'
    case 'span':
      return '**Span**\n\nInline spans use `[text]{attrs}`.'
    case 'heading_ref':
      return crossrefContents(node, resolveRef)
    default:
      return null
  }
}

type RefResolver = (id: string) => CaptionTarget | null

/**
 * A `</#id>` used to fall through this switch entirely, so the LEXICAL rules
 * above took it and reported the `#` inside the reference as a heading marker.
 * It now says what the reference resolves to, which for a composite figure's
 * panel is the group's number plus its letter (PART 9 §4c).
 *
 * A heading target keeps the generic wording: the heading's own text is what
 * the reference renders, and it is already on screen.
 */
function crossrefContents(node: InlineNode, resolveRef: RefResolver): string {
  const generic =
    '**Cross-reference**\n\nA `</#id>` reference links to the heading or captioned host carrying that id.'
  const id = (node as { target?: unknown }).target
  if (typeof id !== 'string') return generic
  const target = resolveRef(id)
  if (!target) return generic
  if (target.text === null) {
    return (
      '**Cross-reference**\n\nAn unnumbered ' + target.kind + '. It is an anchor, but it drew no ' +
      'number, so this reference has no caption text to render.'
    )
  }
  return '**Cross-reference**\n\nResolves to **' + target.text + '** (' + target.kind + ').'
}

function contains(pos: SourcePosition, position: Position): boolean {
  if (
    pos.startColumn === undefined ||
    pos.endColumn === undefined ||
    position.line + 1 < pos.startLine ||
    position.line + 1 > pos.endLine
  ) {
    return false
  }
  if (position.line + 1 === pos.startLine && position.character + 1 < pos.startColumn) return false
  if (position.line + 1 === pos.endLine && position.character + 1 > pos.endColumn) return false
  return true
}

function toRange(pos: SourcePosition, lines: string[]) {
  return {
    start: {
      line: pos.startLine - 1,
      character: astColumnToCharacter(lines[pos.startLine - 1] ?? '', pos.startColumn ?? 1),
    },
    end: {
      line: pos.endLine - 1,
      character: astColumnToCharacter(lines[pos.endLine - 1] ?? '', pos.endColumn ?? 1),
    },
  }
}

function spanSize(pos: SourcePosition): number {
  if (pos.startOffset !== undefined && pos.endOffset !== undefined) return pos.endOffset - pos.startOffset
  return (pos.endLine - pos.startLine) * 1000 + ((pos.endColumn ?? 1) - (pos.startColumn ?? 1))
}
