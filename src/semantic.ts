import { SemanticTokensBuilder, type SemanticTokens } from 'vscode-languageserver/node.js'
import {
  parse,
  resolve,
  type BlockNode,
  type Document,
  type InlineNode,
  type Position,
} from '@markup-carve/carve'

export const semanticTokenTypes = [
  'keyword',
  'string',
  'comment',
  'property',
  'variable',
  'number',
  'operator',
  'type',
] as const

export const semanticTokenModifiers = ['declaration', 'definition', 'readonly'] as const

const tokenTypeIndex = new Map(semanticTokenTypes.map((type, index) => [type, index]))
const tokenModifierIndex = new Map(semanticTokenModifiers.map((modifier, index) => [modifier, index]))

type TokenType = (typeof semanticTokenTypes)[number]
type TokenModifier = (typeof semanticTokenModifiers)[number]

interface Token {
  line: number
  character: number
  length: number
  type: TokenType
  modifiers?: TokenModifier[]
}

export function buildSemanticTokens(source: string): SemanticTokens {
  const builder = new SemanticTokensBuilder()
  for (const token of semanticTokens(source)) {
    builder.push(
      token.line,
      token.character,
      token.length,
      tokenTypeIndex.get(token.type) ?? 0,
      modifierMask(token.modifiers ?? []),
    )
  }
  return builder.build()
}

export function semanticTokens(source: string): Token[] {
  try {
    return astSemanticTokens(resolve(parse(source)), source)
  } catch {
    return lexicalSemanticTokens(source)
  }
}

function astSemanticTokens(doc: Document, source: string): Token[] {
  const tokens: Token[] = []
  const lines = source.replace(/\r\n?/g, '\n').split('\n')
  for (const node of doc.children) collectBlock(tokens, lines, node)
  return withoutOverlaps(
    tokens.sort((a, b) => a.line - b.line || a.character - b.character || b.length - a.length),
  )
}

function collectBlock(tokens: Token[], lines: string[], node: BlockNode): void {
  switch (node.type) {
    case 'heading':
      pushLinePrefix(tokens, lines, node.pos, /^#{1,6}/, 'operator')
      pushHeadingTitle(tokens, lines, node.pos)
      collectInline(tokens, lines, node.children)
      break
    case 'paragraph':
      collectInline(tokens, lines, node.children)
      break
    case 'code-block':
    case 'raw-block':
      pushPosition(tokens, lines, node.pos, 'string')
      break
    case 'comment':
      pushPosition(tokens, lines, node.pos, 'comment')
      break
    case 'blockquote':
      pushLinePrefix(tokens, lines, node.pos, /^\s*>+/, 'operator')
      for (const child of node.children) collectBlock(tokens, lines, child)
      break
    case 'list':
      pushLinePrefix(tokens, lines, node.pos, /^\s*(?:[-+*]|\(?[0-9A-Za-z]+[.)])/, 'operator')
      for (const item of node.items) {
        for (const child of item.children) collectBlock(tokens, lines, child)
      }
      break
    case 'admonition':
      pushLinePrefix(tokens, lines, node.pos, /^\s*:{3,}\s*[A-Za-z][\w-]*/, 'type')
      for (const child of node.children) collectBlock(tokens, lines, child)
      if (node.title) collectInline(tokens, lines, node.title)
      break
    case 'div':
      pushLinePrefix(tokens, lines, node.pos, /^\s*:{3,}/, 'operator')
      for (const child of node.children) collectBlock(tokens, lines, child)
      break
    case 'definition-list':
      for (const item of node.items) {
        for (const term of item.terms) collectInline(tokens, lines, term)
        for (const definition of item.definitions) {
          for (const child of definition) collectBlock(tokens, lines, child)
        }
      }
      break
    case 'figure':
      collectFigureTarget(tokens, lines, node.target)
      collectInline(tokens, lines, node.caption)
      break
    case 'table':
      pushPosition(tokens, lines, node.pos, 'string')
      if (node.caption) collectInline(tokens, lines, node.caption)
      for (const row of node.rows) {
        for (const cell of row.cells) collectInline(tokens, lines, cell.children)
      }
      break
    case 'image':
      pushPosition(tokens, lines, node.pos, 'string')
      break
    case 'thematic-break':
      pushPosition(tokens, lines, node.pos, 'operator')
      break
    case 'abbreviation-def':
      pushPosition(tokens, lines, node.pos, 'property')
      break
  }
}

function collectFigureTarget(tokens: Token[], lines: string[], node: BlockNode): void {
  if (node.type === 'image') pushPosition(tokens, lines, node.pos, 'string')
  else collectBlock(tokens, lines, node)
}

function collectInline(tokens: Token[], lines: string[], nodes: InlineNode[]): void {
  for (const node of nodes) {
    switch (node.type) {
      case 'text':
      case 'soft-break':
      case 'hard-break':
        break
      case 'code':
      case 'math':
      case 'raw-inline':
      case 'link':
      case 'image':
      case 'autolink':
      case 'crossref':
        pushPosition(tokens, lines, node.pos, 'string')
        break
      case 'mention':
      case 'tag':
      case 'emoji':
      case 'footnote':
      case 'abbreviation':
        pushPosition(tokens, lines, node.pos, 'variable', ['readonly'])
        break
      case 'span':
      case 'extension':
        pushPosition(tokens, lines, node.pos, 'property')
        break
      default:
        pushPosition(tokens, lines, node.pos, 'keyword')
        break
    }

    const children = (node as { children?: InlineNode[] }).children
    if (Array.isArray(children)) collectInline(tokens, lines, children)
    const content = (node as { content?: InlineNode[] }).content
    if (Array.isArray(content)) collectInline(tokens, lines, content)
  }
}

function pushPosition(
  tokens: Token[],
  lines: string[],
  pos: Position | undefined,
  type: TokenType,
  modifiers: TokenModifier[] = [],
): void {
  if (
    pos?.startLine === undefined ||
    pos.endLine === undefined ||
    pos.startColumn === undefined ||
    pos.endColumn === undefined
  ) {
    return
  }
  for (let line = pos.startLine; line <= pos.endLine; line++) {
    const text = lines[line - 1] ?? ''
    const startColumn = line === pos.startLine ? pos.startColumn : 1
    const endColumn = line === pos.endLine ? pos.endColumn : text.length + 1
    push(tokens, line - 1, startColumn - 1, Math.max(0, endColumn - startColumn), type, modifiers)
  }
}

function pushLinePrefix(
  tokens: Token[],
  lines: string[],
  pos: Position | undefined,
  pattern: RegExp,
  type: TokenType,
): void {
  if (!pos?.startLine) return
  const line = lines[pos.startLine - 1] ?? ''
  const match = pattern.exec(line)
  if (!match) return
  push(tokens, pos.startLine - 1, match.index, match[0].length, type)
}

function pushHeadingTitle(tokens: Token[], lines: string[], pos: Position | undefined): void {
  if (!pos?.startLine) return
  const line = lines[pos.startLine - 1] ?? ''
  const match = /^(#{1,6})(\s+)(.*)$/.exec(line)
  if (!match) return
  push(tokens, pos.startLine - 1, match[1]!.length + match[2]!.length, match[3]!.length, 'type', [
    'definition',
  ])
}

function lexicalSemanticTokens(source: string): Token[] {
  const tokens: Token[] = []
  const lines = source.replace(/\r\n?/g, '\n').split('\n')
  let inFence: { marker: string; type: 'string' | 'comment' } | undefined
  let inFrontmatter = lines[0]?.trim() === '---'

  for (let line = 0; line < lines.length; line++) {
    const text = lines[line]!

    if (inFrontmatter) {
      const close = line > 0 && text.trim() === '---'
      pushRun(tokens, line, text, 'string')
      if (close) inFrontmatter = false
      continue
    }

    if (inFence) {
      pushRun(tokens, line, text, inFence.type)
      if (new RegExp(`^\\s*${escapeRegExp(inFence.marker)}\\s*$`).test(text)) {
        inFence = undefined
      }
      continue
    }

    const commentBlock = /^%{3,}\s*$/.exec(text)
    if (commentBlock) {
      pushRun(tokens, line, text, 'comment')
      inFence = { marker: commentBlock[0].trim(), type: 'comment' }
      continue
    }

    if (/^%%/.test(text)) {
      pushRun(tokens, line, text, 'comment')
      continue
    }

    const codeFence = /^(\s*)(`{3,}|~{3,})(?:\s+([A-Za-z0-9_-]+))?/.exec(text)
    if (codeFence) {
      push(tokens, line, codeFence[1]!.length, codeFence[2]!.length, 'operator')
      if (codeFence[3]) {
        push(tokens, line, codeFence.index + codeFence[0].lastIndexOf(codeFence[3]), codeFence[3].length, 'type')
      }
      inFence = { marker: codeFence[2]!, type: 'string' }
      continue
    }

    const rawFence = /^(\s*)(%{3,})(?:\s+([A-Za-z0-9_-]+))?/.exec(text)
    if (rawFence) {
      push(tokens, line, rawFence[1]!.length, rawFence[2]!.length, 'operator')
      if (rawFence[3]) {
        push(tokens, line, rawFence.index + rawFence[0].lastIndexOf(rawFence[3]), rawFence[3].length, 'type')
      }
      inFence = { marker: rawFence[2]!, type: 'string' }
      continue
    }

    const heading = /^(#{1,6})(\s+)(.+)$/.exec(text)
    if (heading) {
      push(tokens, line, 0, heading[1]!.length, 'operator')
      push(tokens, line, heading[1]!.length + heading[2]!.length, heading[3]!.length, 'type', ['definition'])
      scanInline(tokens, line, text)
      continue
    }

    const div = /^(\s*)(:{3,})(?:\s+([A-Za-z][\w-]*))?/.exec(text)
    if (div) {
      push(tokens, line, div[1]!.length, div[2]!.length, 'operator')
      if (div[3]) push(tokens, line, div[0].lastIndexOf(div[3]), div[3].length, 'type')
    }

    const list = /^(\s*)([-+*]|\(?[0-9]+[.)]|\(?[A-Za-z][.)])\s+(\[[ xX]\]\s+)?/.exec(text)
    if (list) {
      push(tokens, line, list[1]!.length, list[2]!.length, 'operator')
      if (list[3]) push(tokens, line, list[1]!.length + list[2]!.length + 1, list[3].trimEnd().length, 'keyword')
    }

    const quote = /^(\s*>+)\s?/.exec(text)
    if (quote) push(tokens, line, quote[1]!.search(/>/), quote[1]!.trimStart().length, 'operator')

    scanInline(tokens, line, text)
  }

  return withoutOverlaps(
    tokens.sort((a, b) => a.line - b.line || a.character - b.character || b.length - a.length),
  )
}

function scanInline(tokens: Token[], line: number, text: string): void {
  scan(tokens, line, text, /`[^`\n]+`/g, 'string')
  scan(tokens, line, text, /\$[^$\n]+\$/g, 'string')
  scan(tokens, line, text, /!\[[^\]\n]*\]\([^\s)]+(?:\s+"[^"]*")?\)/g, 'string')
  scan(tokens, line, text, /\[[^\]\n]+\]\([^\s)]+(?:\s+"[^"]*")?\)/g, 'string')
  scan(tokens, line, text, /\[\^[^\]\n]+\]/g, 'variable')
  scan(tokens, line, text, /(?<![\w.])@[A-Za-z0-9_][A-Za-z0-9_-]*/g, 'variable', ['readonly'])
  scan(tokens, line, text, /(?<!\w)#[A-Za-z0-9_][A-Za-z0-9_-]*/g, 'variable', ['readonly'])
  scan(tokens, line, text, /:[A-Za-z0-9_+-]+:/g, 'variable')
  scan(tokens, line, text, /\{[^}\n]+\}/g, 'property')
  scan(tokens, line, text, /\\./g, 'operator')
  scan(tokens, line, text, /(\*\*\*[^*\n]+\*\*\*|\*[^*\n]+\*|\/[^/\n]+\/|_[^_\n]+_|~[^~\n]+~|\+\+[^+\n]+\+\+|--[^-\n]+--|==[^=\n]+==|\^[^^\n]+\^|,,[^,\n]+,,)/g, 'keyword')
}

function scan(
  tokens: Token[],
  line: number,
  text: string,
  pattern: RegExp,
  type: TokenType,
  modifiers: TokenModifier[] = [],
): void {
  for (const match of text.matchAll(pattern)) {
    if (match.index === undefined || match[0].length === 0) continue
    push(tokens, line, match.index, match[0].length, type, modifiers)
  }
}

function pushRun(tokens: Token[], line: number, text: string, type: TokenType): void {
  if (text.length > 0) push(tokens, line, 0, text.length, type)
}

function push(
  tokens: Token[],
  line: number,
  character: number,
  length: number,
  type: TokenType,
  modifiers: TokenModifier[] = [],
): void {
  if (length <= 0) return
  tokens.push({ line, character, length, type, modifiers })
}

function modifierMask(modifiers: TokenModifier[]): number {
  let mask = 0
  for (const modifier of modifiers) {
    const index = tokenModifierIndex.get(modifier)
    if (index !== undefined) mask |= 1 << index
  }
  return mask
}

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
}

function withoutOverlaps(tokens: Token[]): Token[] {
  const filtered: Token[] = []
  for (const token of tokens) {
    const previous = filtered[filtered.length - 1]
    if (
      previous &&
      previous.line === token.line &&
      token.character < previous.character + previous.length
    ) {
      continue
    }
    filtered.push(token)
  }
  return filtered
}
