import { SemanticTokensBuilder, type SemanticTokens } from 'vscode-languageserver/node.js'
import { type Document, type Position } from './engine.js'
import { grammarTokens, type GrammarToken } from './grammar-tokens.js'
import { resolvedDocument } from './parse-cache.js'
import { astColumnToCharacter, astOffsetToIndex } from './position.js'
import { walkNodes, type AstNode } from './ast-walk.js'
import { SEMANTIC_SPAN_EXTENSION_NAMES } from './semantic-span-names.js'
import { delimitedTableFormat, ownPos } from './tree.js'

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

export interface Token {
  line: number
  character: number
  length: number
  type: TokenType
  modifiers?: TokenModifier[]
}

export function buildSemanticTokens(source: string, builder = new SemanticTokensBuilder(), options: SemanticOptions = {}): SemanticTokens {
  fillBuilder(builder, semanticTokens(source, options))
  return builder.build()
}

export function buildSemanticTokensRange(source: string, startLine: number, endLine: number, options: SemanticOptions = {}): SemanticTokens {
  const builder = new SemanticTokensBuilder()
  fillBuilder(builder, semanticTokens(source, options).filter((token) => token.line >= startLine && token.line <= endLine))
  return builder.build()
}

export function updateSemanticTokens(source: string, builder: SemanticTokensBuilder, previousResultId: string, options: SemanticOptions = {}) {
  builder.previousResult(previousResultId)
  fillBuilder(builder, semanticTokens(source, options))
  return builder.buildEdits()
}

function fillBuilder(builder: SemanticTokensBuilder, tokens: Token[]): void {
  for (const token of tokens) {
    builder.push(
      token.line,
      token.character,
      token.length,
      tokenTypeIndex.get(token.type) ?? 0,
      modifierMask(token.modifiers ?? []),
    )
  }
}

export interface SemanticOptions {
  extensions?: readonly string[]
}

/*
 * Semantic tokens come from the carve-grammars TextMate grammar (carve-lsp#651),
 * pinned in carve-grammar.ts, so the editor grammar and the server color a line
 * the same way. The tree adds only what a line grammar cannot know: which
 * attribute keys a block consumes, and which span names are semantic under the
 * enabled extensions. Those become `keyword` inside the grammar's `property` run.
 */
export function semanticTokens(source: string, options: SemanticOptions = {}): Token[] {
  let tokens = fromGrammar(source)
  let keywords: Token[] = []
  try {
    const doc = resolvedDocument(source)
    keywords = treeKeywords(doc, source, options)
    tokens = withSnippets(tokens, doc, source)
  } catch {
    // A source the engine refuses still gets the grammar's tokens.
  }
  return withoutOverlaps(
    splitProperties(tokens, keywords).sort((a, b) => a.line - b.line || a.character - b.character || b.length - a.length),
  )
}

type Mapped = { type: TokenType; modifiers?: TokenModifier[] } | null

const has = (scopes: string[], prefix: string) => scopes.some((scope) => scope.startsWith(prefix))

/**
 * The token type of one grammar token, from its scopes (outermost first). A
 * construct is colored as one run, as the tree path colored the node: a link,
 * its brackets and its destination are one `string`.
 */
export function tokenTypeOf(scopes: string[], text = ''): Mapped {
  // A code body carries no token: a semantic token overrides the editor grammar,
  // and one `string` over the body would flatten the fence language.
  if (has(scopes, 'markup.raw.code') || (has(scopes, 'markup.fenced_code') && has(scopes, 'meta.embedded'))) return null
  if (has(scopes, 'meta.frontmatter')) return { type: 'string' }
  if (has(scopes, 'comment.') || has(scopes, 'markup.deleted')) return { type: 'comment' }
  if (has(scopes, 'markup.raw.inline') || has(scopes, 'markup.math') || has(scopes, 'punctuation.definition.raw') ||
    has(scopes, 'punctuation.definition.literal') || has(scopes, 'punctuation.definition.math')) {
    return { type: 'string' }
  }
  if (has(scopes, 'markup.inserted')) return { type: 'type' }
  if (has(scopes, 'keyword.operator.table.alignment')) return { type: 'keyword' }
  if (has(scopes, 'meta.link.reference.def')) {
    if (has(scopes, 'constant.other.reference')) return { type: 'type' }
    if (has(scopes, 'markup.underline.link')) return { type: 'string' }
    if (has(scopes, 'punctuation.')) return { type: 'operator' }
    return null
  }
  if (has(scopes, 'meta.abbreviation')) return { type: 'property' }
  if (has(scopes, 'meta.figure-group') && (has(scopes, 'punctuation.definition.figure-group') || has(scopes, 'entity.name.tag.figure-group'))) {
    return { type: 'type' }
  }
  // A div sigil such as the `>` of a quote fence is a marker, not a kind word.
  if (has(scopes, 'entity.name.tag.admonition') && !/\w/.test(text)) return { type: 'operator' }
  if (has(scopes, 'meta.attributes') || has(scopes, 'punctuation.definition.attributes') ||
    has(scopes, 'punctuation.definition.span')) {
    return { type: 'property' }
  }
  if (has(scopes, 'variable.other.mention') || has(scopes, 'variable.other.tag') ||
    has(scopes, 'punctuation.definition.mention') || has(scopes, 'punctuation.definition.tag') ||
    has(scopes, 'constant.other.footnote') || has(scopes, 'punctuation.definition.footnote') || has(scopes, 'string.other.footnote') ||
    has(scopes, 'constant.language.symbol') || has(scopes, 'punctuation.definition.symbol')) {
    return { type: 'variable', modifiers: ['readonly'] }
  }
  if (has(scopes, 'markup.underline.link') || has(scopes, 'string.other.link') || has(scopes, 'string.other.image') ||
    has(scopes, 'punctuation.definition.link') || has(scopes, 'punctuation.definition.image')) {
    return { type: 'string' }
  }
  if (has(scopes, 'entity.name.section')) return { type: 'type', modifiers: ['definition'] }
  if (has(scopes, 'fenced_code.block.language') || has(scopes, 'entity.name.tag') || has(scopes, 'entity.name.type')) return { type: 'type' }
  if (has(scopes, 'constant.language.checkbox') || has(scopes, 'punctuation.definition.checkbox')) return { type: 'keyword' }
  if (has(scopes, 'keyword.operator') || has(scopes, 'constant.character.escape') || has(scopes, 'meta.separator') ||
    has(scopes, 'punctuation.separator') || has(scopes, 'punctuation.definition.heading') ||
    has(scopes, 'punctuation.definition.fenced') || has(scopes, 'punctuation.definition.admonition') ||
    has(scopes, 'punctuation.definition.list') || has(scopes, 'punctuation.definition.quote') ||
    has(scopes, 'punctuation.definition.caption')) {
    return { type: 'operator' }
  }
  if (has(scopes, 'markup.bold.table')) return null
  if (has(scopes, 'markup.bold') || has(scopes, 'markup.italic') || has(scopes, 'markup.strikethrough') ||
    has(scopes, 'markup.highlight') || has(scopes, 'markup.superscript') || has(scopes, 'markup.subscript') ||
    has(scopes, 'markup.underline') || has(scopes, 'markup.changed') || has(scopes, 'punctuation.definition.')) {
    return { type: 'keyword' }
  }
  if (has(scopes, 'constant.numeric')) return { type: 'number' }
  if (has(scopes, 'keyword.')) return { type: 'keyword' }
  return null
}

// tokenTypeOf depends on the text only through `\w`, so that bit joins the scopes in the key.
const mappedTypes = new Map<string, Mapped>()
function mappedType(scopes: string[], text: string): Mapped {
  const key = (/\w/.test(text) ? 'w ' : '_ ') + scopes.join(' ')
  let mapped = mappedTypes.get(key)
  if (mapped === undefined) {
    mapped = tokenTypeOf(scopes, text)
    mappedTypes.set(key, mapped)
  }
  return mapped
}

function fromGrammar(source: string): Token[] {
  const lines = source.replace(/\r\n?/g, '\n').split('\n')
  const pieces = grammarTokens(source)
  const runs: Token[] = []
  for (let index = 0; index < pieces.length; index++) {
    const token = pieces[index]!
    const text = lines[token.line]!.slice(token.start, token.end)
    const definition = footnoteDefinition(pieces, index, lines)
    if (definition) {
      push(runs, token.line, token.start, 2, 'operator')
      push(runs, token.line, token.start + 2, definition.label, 'type')
      push(runs, token.line, token.start + 2 + definition.label, 2, 'operator')
      index = definition.next - 1
      continue
    }
    const mapped = mappedType(token.scopes, text)
    if (!mapped) continue
    const previous = runs[runs.length - 1]
    // Adjacent pieces of one construct merge into one token, also across a space the construct owns.
    const gap = previous && previous.line === token.line ? lines[token.line]!.slice(previous.character + previous.length, token.start) : undefined
    if (previous && gap !== undefined && (gap === '' || (mapped.type !== 'operator' && /^[ \t]+$/.test(gap) && sameConstruct(pieces, index))) &&
      previous.type === mapped.type && (previous.modifiers ?? []).join() === (mapped.modifiers ?? []).join()) {
      previous.length = token.end - previous.character
      continue
    }
    push(runs, token.line, token.start, token.end - token.start, mapped.type, mapped.modifiers)
  }
  // Spaces and tabs at either end of a run carry no color: a fence closer's indent is no part of its marker.
  const tokens: Token[] = []
  for (const run of runs) {
    const text = lines[run.line]!.slice(run.character, run.character + run.length)
    const start = run.character + text.length - text.trimStart().length
    push(tokens, run.line, start, text.trim().length, run.type, run.modifiers)
  }
  return tokens
}

// The whitespace piece before pieces[index] lies inside a construct (a meta scope) the piece shares.
function sameConstruct(pieces: GrammarToken[], index: number): boolean {
  const space = pieces[index - 1]
  if (!space) return false
  const meta = space.scopes.filter((scope) => scope.startsWith('meta.'))
  return meta.length > 0 && meta.every((scope) => pieces[index]!.scopes.includes(scope))
}

/*
 * The grammar scopes a footnote definition `[^label]:` like a reference `[^label]`
 * plus a `:` separator. At the start of a line that is the definition, colored as
 * a link definition is: `[^` and `]:` markers around a `type` label.
 */
function footnoteDefinition(pieces: GrammarToken[], index: number, lines: string[]): { label: number; next: number } | undefined {
  const first = pieces[index]!
  const line = lines[first.line]!
  if (!has(first.scopes, 'punctuation.definition.footnote') || line.slice(0, first.start).trim() !== '') return undefined
  const match = /^\[\^([^\]\n]+)\]:/.exec(line.slice(first.start))
  if (!match) return undefined
  const end = first.start + match[0].length
  let next = index
  while (next < pieces.length && pieces[next]!.line === first.line && pieces[next]!.start < end) next++
  if (!pieces.slice(index, next).some((piece) => has(piece.scopes, 'punctuation.separator'))) return undefined
  return { label: match[1]!.length, next }
}

// Attribute keys a block consumes, and span names, from the tree.
const SNIPPET_TEXT = /\{\$|\{\{ +\$/

/**
 * The grammar has no snippet scope: it reads a use as an include path and a
 * definition as text. The tree's snippet nodes replace whatever it gave
 * those characters: braces and `:` as `operator`, the name as `variable`.
 */
function withSnippets(tokens: Token[], doc: Document, source: string): Token[] {
  if (!SNIPPET_TEXT.test(source)) return tokens
  const text = source.replace(/\r\n?/g, '\n')
  const starts = [0]
  for (let index = 0; index < text.length; index += 1) if (text[index] === '\n') starts.push(index + 1)
  const lineOf = (index: number): number => {
    let low = 0
    let high = starts.length - 1
    while (low < high) {
      const mid = (low + high + 1) >> 1
      if (starts[mid]! <= index) low = mid
      else high = mid - 1
    }
    return low
  }
  const snippet: Token[] = []
  // The whole marker or use, spaces included, which no grammar token keeps.
  const covers: Token[] = []
  walkNodes(doc, (node) => {
    if (node.type !== 'snippet_definition' && node.type !== 'snippet_use') return
    const name = typeof node.name === 'string' ? node.name : ''
    if (node.pos?.startOffset === undefined || node.pos.endOffset === undefined || !name) return false
    const end = astOffsetToIndex(text, node.pos.endOffset)
    if (node.type === 'snippet_use') {
      const start = astOffsetToIndex(text, node.pos.startOffset)
      const line = lineOf(start)
      const character = start - starts[line]!
      const dollar = text.indexOf('$', start) - starts[line]!
      push(snippet, line, character, 2, 'operator')
      push(snippet, line, dollar, name.length + 1, 'variable')
      push(snippet, line, end - starts[line]! - 2, 2, 'operator')
      push(covers, line, character, end - start, 'operator')
      return false
    }
    // The marker is the definition's last line; its value starts after `: `.
    const line = lineOf(end)
    const lineStart = starts[line]!
    if (!text.startsWith(`{$${name}`, lineStart)) return
    const first = (Array.isArray(node.children) ? node.children as AstNode[] : []).find((child) => child.pos?.startOffset !== undefined)
    const colon = first ? astOffsetToIndex(text, first.pos!.startOffset!) - 2 - lineStart : -1
    if (colon < 2 + name.length || text[lineStart + colon] !== ':') return
    push(covers, line, 0, colon + 1, 'operator')
    push(snippet, line, 0, 2, 'operator')
    push(snippet, line, 2, name.length, 'variable', ['declaration'])
    const tail = text.slice(lineStart + 2 + name.length, lineStart + colon)
    if (tail === '}') {
      push(snippet, line, 2 + name.length, 2, 'operator')
    } else {
      push(snippet, line, 2 + name.length, tail.length, 'property')
      push(snippet, line, colon, 1, 'operator')
    }
    // The value may hold uses of its own.
  })
  if (snippet.length === 0) return tokens
  const byLine = new Map<number, Token[]>()
  for (const token of covers) byLine.set(token.line, [...(byLine.get(token.line) ?? []), token])
  // A grammar run that spans a use (`*a {{ $v }} b*`) keeps its parts on either side.
  const kept: Token[] = []
  for (const token of tokens) {
    let pieces = [token]
    for (const other of byLine.get(token.line) ?? []) {
      pieces = pieces.flatMap((piece) => {
        const end = piece.character + piece.length
        const otherEnd = other.character + other.length
        if (piece.character >= otherEnd || other.character >= end) return [piece]
        const parts: Token[] = []
        if (piece.character < other.character) parts.push({ ...piece, length: other.character - piece.character })
        if (otherEnd < end) parts.push({ ...piece, character: otherEnd, length: end - otherEnd })
        return parts
      })
    }
    kept.push(...pieces)
  }
  return [...kept, ...snippet]
}

function treeKeywords(doc: Document, source: string, options: SemanticOptions): Token[] {
  const spanNames = options.extensions?.includes('semantic-span')
    ? ['kbd', 'abbr', 'time', ...SEMANTIC_SPAN_EXTENSION_NAMES]
    : ['kbd', 'abbr', 'time']
  const lines = source.replace(/\r\n?/g, '\n').split('\n')
  const keywords: Token[] = []
  const visit = (value: unknown): void => {
    if (Array.isArray(value)) {
      for (const item of value) visit(item)
      return
    }
    if (value === null || typeof value !== 'object') return
    const node = value as { type?: string; pos?: Position }
    if (node.type === 'table' || node.type === 'list' || node.type === 'definition_list') {
      const pos = ownPos(node.pos, lines)
      const names = node.type === 'table'
        ? (delimitedTableFormat(node as never, lines) ? ['table'] : ['header-rows', 'footer-rows', 'header-cols', 'aligns', 'valigns', 'widths'])
        : ['loose']
      if (pos?.startLine !== undefined) {
        for (let line = pos.startLine - 2; line >= 0; line--) {
          const value = lines[line]!.trim()
          if (!value) continue
          if (!/^\{[^}\n]+\}$/.test(value)) break
          collectAttributeKeywords(keywords, line, lines[line]!, names)
        }
      }
    }
    if (node.type === 'span' && node.pos?.endLine !== undefined && node.pos.endColumn !== undefined) {
      const line = node.pos.endLine - 1
      const text = lines[line] ?? ''
      const end = astColumnToCharacter(text, node.pos.endColumn)
      const attrs = /\{[^}\n]+\}$/.exec(text.slice(0, end))
      if (attrs) collectAttributeKeywords(keywords, line, attrs[0], spanNames, end - attrs[0].length)
    }
    for (const key of Object.keys(node)) if (key !== 'pos') visit((node as Record<string, unknown>)[key])
  }
  visit(doc.children)
  return keywords
}

function collectAttributeKeywords(tokens: Token[], line: number, text: string, names: string[], offset = 0): void {
  for (const block of text.matchAll(/\{[^}\n]+\}/g)) {
    for (const key of block[0].matchAll(/(?:^|[\s{])([A-Za-z][\w-]*)(?=[\s}=])/g)) {
      if (names.includes(key[1]!)) {
        push(tokens, line, offset + block.index! + key.index! + key[0].length - key[1]!.length, key[1]!.length, 'keyword')
      }
    }
  }
}

function splitProperties(tokens: Token[], keywords: Token[]): Token[] {
  const result: Token[] = []
  for (const token of tokens) {
    if (token.type !== 'property') {
      result.push(token)
      continue
    }
    let start = token.character
    const end = start + token.length
    for (const key of keywords.filter((item) => item.line === token.line && item.character >= start && item.character + item.length <= end)
      .sort((a, b) => a.character - b.character)) {
      push(result, token.line, start, key.character - start, 'property')
      start = key.character + key.length
    }
    push(result, token.line, start, end - start, 'property')
  }
  result.push(...keywords)
  return result
}

/*
 * MARKER SEPARATORS ARE A LITERAL SPACE.
 *
 * Exported so the rule can be asserted directly. Most of it is NOT observable
 * through `semanticTokens`: that prefers the AST path, so what a marker line
 * becomes is decided by the pinned engine rather than by these patterns, and
 * the pinned engine is old enough to still make `><TAB>q` a blockquote
 * (carve-lsp#37). Testing through it would measure the dependency.
 *
 * `resources/grammar.ebnf` keeps two terminals apart on purpose - `whitespace`
 * is `' ' | '\t'`, `space` is `' '` - and every marker below takes `space`.
 * Separators are literal; indentation is columns, and a separator is not
 * indentation (carve#692, carve#698).
 *
 * These were spelled `\s` in five places across two functions, so the editor
 * colored a checkbox, a quote marker and a reference label on lines every
 * engine renders as ordinary paragraph text (carve-lsp#38). Named once here
 * because the same rule living in five regexes is why the earlier pass over
 * these patterns fixed only the ones a report happened to name.
 *
 * How much whitespace each admits AFTER the required space is measured against
 * the engine, not assumed - they differ:
 *
 *   `[a]: <TAB>/u`   defines      -> further whitespace is content's problem
 *   `- [ ] <TAB>a`   NOT a task   -> the run is spaces, and content follows
 *   `>  q` and `> <TAB>q`         -> both quote
 */

// Footnotes and abbreviations require content after a space.
export const DEF_SEPARATOR = String.raw`\]: [ \t]*`
// Link references also permit a bare empty destination after ASCII trim.
export const REF_SEPARATOR = String.raw`\]:(?: [ \t]*(?=\S)|[ \t]*$)`

// `blockquote_line = '>', (newline | (space, inline_content, newline))`. A bare
// `>` is a blockquote line, which is why the space is optional only at
// end-of-line.
export const QUOTE_PREFIX = /^([ \t]*>+)(?: |$)/

// `unordered_item = bullet_marker, [item_attributes], space, [task_marker], ...`
// with `bullet_marker = '-' | '*'` - `+` is the list CONTINUATION marker, not a
// bullet, so a `+ ` line is paragraph text.
//
// `task_marker = '[', task_state, ']', space`, and `task_state` is any of
// ` x X - _ / ! > ?`; the old class admitted only ` xX`, so four of the original seven
// states were not colored at all. The lookahead is the measured behavior: the
// separator run is spaces, and what follows has to be content.
// The marker alone, for the AST path, which already knows the line opens a
// list and only needs the marker's width. Same bullet class: `+` is not one.
export const LIST_MARKER_ONLY = /^[ \t]*(?:[-*]|\.(?= |$)|\(?[0-9A-Za-z]+[.)])/

export const LIST_PREFIX = /^([ \t]*)([-*]|\(?[0-9]+[.)]|\(?[A-Za-z][.)]) +(\[[ xX\-_>\/!?]\] +(?=\S))?/

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
