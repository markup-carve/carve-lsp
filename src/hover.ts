import { MarkupKind, type Hover, type Position } from 'vscode-languageserver/node.js'
import {
  parse,
  resolve,
  type BlockNode,
  type Document,
  type InlineNode,
  type Position as SourcePosition,
} from '@markup-carve/carve'

interface HoverRule {
  pattern: RegExp
  contents: string
}

const rules: HoverRule[] = [
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
    pattern: /,,[^,\n]+,,/g,
    contents: '**Subscript**\n\nCarve subscript uses double commas: `,,2,,`.',
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
  try {
    const hover = astHoverAt(resolve(parse(source)), position)
    if (hover) return hover
  } catch {
    // Fall back to lexical help below for documents that do not parse.
  }

  const line = source.replace(/\r\n?/g, '\n').split('\n')[position.line]
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

function astHoverAt(doc: Document, position: Position): Hover | null {
  const matches: Array<{ pos: SourcePosition; contents: string }> = []
  for (const node of doc.children) collectBlock(matches, node, position)
  matches.sort((a, b) => spanSize(a.pos) - spanSize(b.pos))
  const match = matches[0]
  if (!match) return null
  return {
    contents: {
      kind: MarkupKind.Markdown,
      value: match.contents,
    },
    range: toRange(match.pos),
  }
}

function collectBlock(
  matches: Array<{ pos: SourcePosition; contents: string }>,
  node: BlockNode,
  position: Position,
): void {
  addMatch(matches, node.pos, position, blockContents(node))
  switch (node.type) {
    case 'heading':
      collectInline(matches, node.children, position)
      break
    case 'paragraph':
      collectInline(matches, node.children, position)
      break
    case 'blockquote':
      node.children.forEach((child) => collectBlock(matches, child, position))
      break
    case 'list':
      node.items.forEach((item) => item.children.forEach((child) => collectBlock(matches, child, position)))
      break
    case 'admonition':
    case 'div':
      node.children.forEach((child) => collectBlock(matches, child, position))
      if (node.type === 'admonition' && node.title) collectInline(matches, node.title, position)
      break
    case 'definition-list':
      node.items.forEach((item) => {
        item.terms.forEach((term) => collectInline(matches, term, position))
        item.definitions.forEach((definition) =>
          definition.forEach((child) => collectBlock(matches, child, position)),
        )
      })
      break
    case 'figure':
      collectBlock(matches, node.target, position)
      collectInline(matches, node.caption, position)
      break
    case 'table':
      if (node.caption) collectInline(matches, node.caption, position)
      node.rows.forEach((row) => row.cells.forEach((cell) => collectInline(matches, cell.children, position)))
      break
  }
}

function collectInline(
  matches: Array<{ pos: SourcePosition; contents: string }>,
  nodes: InlineNode[],
  position: Position,
): void {
  for (const node of nodes) {
    addMatch(matches, node.pos, position, inlineContents(node))
    const children = (node as { children?: InlineNode[] }).children
    if (Array.isArray(children)) collectInline(matches, children, position)
    const content = (node as { content?: InlineNode[] }).content
    if (Array.isArray(content)) collectInline(matches, content, position)
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
    case 'code-block':
      return '**Code Block**\n\nTriple backtick or tilde fences create verbatim code blocks.'
    case 'raw-block':
      return '**Raw Block**\n\nRaw passthrough blocks render only for matching output formats.'
    case 'blockquote':
      return '**Block Quote**\n\nLines beginning with `>` create quoted blocks.'
    case 'list':
      return '**List**\n\nUse bullets, task markers, or ordered markers for lists.'
    case 'table':
      return '**Table**\n\nPipe-delimited rows create tables.'
    case 'admonition':
      return '**Admonition**\n\nTyped `:::` fences create admonition blocks.'
    case 'div':
      return '**Div**\n\nBare `:::` fences create generic container blocks.'
    default:
      return null
  }
}

function inlineContents(node: InlineNode): string | null {
  switch (node.type) {
    case 'strong':
      return '**Bold**\n\nCarve uses single asterisks for bold text: `*bold*`.'
    case 'italic':
      return '**Italic**\n\nCarve uses slashes for italic text: `/italic/`.'
    case 'underline':
      return '**Underline**\n\nCarve uses underscores for underline: `_underlined_`.'
    case 'strike':
      return '**Strikethrough**\n\nCarve uses tildes for strikethrough: `~removed~`.'
    case 'sub':
      return '**Subscript**\n\nCarve subscript uses double commas: `,,2,,`.'
    case 'super':
      return '**Superscript**\n\nCarve superscript uses carets: `^2^`.'
    case 'highlight':
      return '**Highlight**\n\nCarve highlight uses double equals: `==marked==`.'
    case 'code':
      return '**Inline Code**\n\nBackticks mark inline code spans.'
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
    default:
      return null
  }
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

function toRange(pos: SourcePosition) {
  return {
    start: { line: pos.startLine - 1, character: (pos.startColumn ?? 1) - 1 },
    end: { line: pos.endLine - 1, character: (pos.endColumn ?? 1) - 1 },
  }
}

function spanSize(pos: SourcePosition): number {
  if (pos.startOffset !== undefined && pos.endOffset !== undefined) return pos.endOffset - pos.startOffset
  return (pos.endLine - pos.startLine) * 1000 + ((pos.endColumn ?? 1) - (pos.startColumn ?? 1))
}
