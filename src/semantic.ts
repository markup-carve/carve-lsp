import { SemanticTokensBuilder, type SemanticTokens } from 'vscode-languageserver/node.js'

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
