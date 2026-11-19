import { utf8Length, type Document, type Position } from './engine.js'

// Inline nodes, plus the comment nodes whose own line is the `{% %}` brace.
const NOT_A_BLOCK = new Set([
  'abbreviation', 'autolink', 'caption_number', 'citation_group', 'code', 'comment', 'critic_comment', 'delete',
  'emphasis', 'footnote_ref', 'hard_break', 'highlight', 'image', 'inline_extension', 'inline_footnote', 'insert',
  'link', 'literal_inline', 'math', 'mention', 'non_breaking_space', 'raw_inline', 'ruby', 'small_caps',
  'smart_punctuation', 'soft_break', 'span', 'strike', 'strong', 'subscript', 'superscript', 'symbol', 'tag', 'text',
  'underline', 'xref',
])

const ATTRIBUTE_LINE = /^\{[^{}\n]*\}[ \t]*$/

/**
 * A 0.2 block position starts at the block attribute lines written above the
 * block; every feature here reads the block's own first line, so those lines
 * are moved out of the position, in place. Offsets stay UTF-8 bytes.
 */
export function trimAttributeLines(doc: Document, source: string): Document {
  const lines = source.split(/\r\n?|\n/)
  const lineBytes: number[] = [0]
  const breaks = /\r\n?|\n/g
  let match: RegExpExecArray | null
  let last = 0
  while ((match = breaks.exec(source)) !== null) {
    lineBytes.push(lineBytes[lineBytes.length - 1]! + utf8Length(source.slice(last, match.index + match[0].length)))
    last = match.index + match[0].length
  }
  const visit = (value: unknown): void => {
    if (Array.isArray(value)) {
      for (const item of value) visit(item)
      return
    }
    if (value === null || typeof value !== 'object') return
    const node = value as { type?: string; pos?: Position }
    if (typeof node.type === 'string' && !NOT_A_BLOCK.has(node.type) && node.pos && node.pos.file === undefined) trim(node.pos, lines, lineBytes)
    for (const key of Object.keys(node)) if (key !== 'pos') visit((node as Record<string, unknown>)[key])
  }
  visit(doc.children)
  return doc
}

function trim(pos: Position, lines: string[], lineBytes: number[]): void {
  while (pos.startLine < pos.endLine) {
    const text = lines[pos.startLine - 1] ?? ''
    const prefix = [...text].slice(0, pos.startColumn - 1).join('')
    if (!ATTRIBUTE_LINE.test(text.slice(prefix.length))) return
    const next = lines[pos.startLine] ?? ''
    const nextPrefix = [...next].slice(0, [...prefix].length).join('')
    const indent = /^[ \t]*/.exec(next.slice(nextPrefix.length))![0]
    const column = [...nextPrefix].length + indent.length + 1
    pos.startLine += 1
    pos.startColumn = column
    pos.startOffset = (lineBytes[pos.startLine - 1] ?? pos.startOffset) + utf8Length(nextPrefix + indent)
  }
}
