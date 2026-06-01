import { MarkupKind, type Hover, type Position } from 'vscode-languageserver/node.js'

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
