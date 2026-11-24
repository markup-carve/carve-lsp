import { createHighlighterCoreSync } from '@shikijs/core'
import { createJavaScriptRegexEngine } from '@shikijs/engine-javascript'
import { carveGrammarSource } from './carve-grammar.js'

/** One TextMate token of a line: UTF-16 offsets into the line and its scopes, outermost first. */
export interface GrammarToken {
  line: number
  start: number
  end: number
  scopes: string[]
}

interface LineState {
  equals(other: LineState): boolean
}

interface LineGrammar {
  tokenizeLine(line: string, state: LineState | null): { tokens: { startIndex: number; endIndex: number; scopes: string[] }[]; ruleStack: LineState }
}

let grammar: LineGrammar | undefined

function carveGrammar(): LineGrammar {
  if (!grammar) {
    // Pure JavaScript: the regex engine compiles Oniguruma patterns to RegExp, so no WASM
    // and no Node.js built-in is reached. Embedded fence languages are not loaded: a code
    // body carries no semantic token anyway.
    const highlighter = createHighlighterCoreSync({
      langs: [{ ...JSON.parse(carveGrammarSource), name: 'carve' }],
      themes: [],
      engine: createJavaScriptRegexEngine({ forgiving: true }),
    })
    grammar = highlighter.getLanguage('carve') as unknown as LineGrammar
  }
  return grammar
}

type LineTokens = { start: number; end: number; scopes: string[] }[]

/** A tokenized source: per line its tokens and the grammar state after it. */
interface Tokenized {
  lines: string[]
  tokens: LineTokens[]
  states: LineState[]
}

// The last few sources, so an edit re-tokenizes only from its first changed line
// up to where the grammar state meets the previous run again.
const recent: Tokenized[] = []
const RECENT = 8

/** Forgets the recent sources; the next call tokenizes from the first line. */
export function clearGrammarCache(): void {
  recent.length = 0
}

const sameState = (a: LineState | null, b: LineState | null) => a === b || (a !== null && b !== null && a.equals(b))

function tokenize(lines: string[]): Tokenized {
  let previous: Tokenized | undefined
  let prefix = 0
  for (const candidate of recent) {
    let common = 0
    const limit = Math.min(candidate.lines.length, lines.length)
    while (common < limit && candidate.lines[common] === lines[common]) common++
    if (!previous || common > prefix) [previous, prefix] = [candidate, common]
  }
  if (previous && prefix === lines.length && prefix === previous.lines.length) return previous
  const grammar = carveGrammar()
  const out: Tokenized = { lines, tokens: [], states: [] }
  for (let line = 0; line < prefix; line++) {
    out.tokens.push(previous!.tokens[line]!)
    out.states.push(previous!.states[line]!)
  }
  let suffix = 0
  if (previous) {
    const limit = Math.min(previous.lines.length, lines.length) - prefix
    while (suffix < limit && previous.lines[previous.lines.length - 1 - suffix] === lines[lines.length - 1 - suffix]) suffix++
  }
  const shift = previous ? previous.lines.length - lines.length : 0
  let state: LineState | null = prefix > 0 ? out.states[prefix - 1]! : null
  for (let line = prefix; line < lines.length; line++) {
    if (previous && line >= lines.length - suffix) {
      const old = line + shift
      if (sameState(state, old > 0 ? previous.states[old - 1]! : null)) {
        for (let rest = line; rest < lines.length; rest++) {
          out.tokens.push(previous.tokens[rest + shift]!)
          out.states.push(previous.states[rest + shift]!)
        }
        break
      }
    }
    const result = grammar.tokenizeLine(lines[line]!, state)
    state = result.ruleStack
    // The last token of a line reaches one past its end, over the line feed.
    const length = lines[line]!.length
    const tokens: LineTokens = []
    for (const token of result.tokens) {
      const end = Math.min(token.endIndex, length)
      if (end > token.startIndex) tokens.push({ start: token.startIndex, end, scopes: token.scopes })
    }
    out.tokens.push(tokens)
    out.states.push(state)
  }
  recent.unshift(out)
  recent.length = Math.min(recent.length, RECENT)
  return out
}

/** TextMate tokens of every line of `source`, from the carve-grammars grammar pinned in carve-grammar.ts. */
export function grammarTokens(source: string): GrammarToken[] {
  const { tokens } = tokenize(source.replace(/\r\n?/g, '\n').split('\n'))
  const out: GrammarToken[] = []
  for (let line = 0; line < tokens.length; line++) {
    for (const token of tokens[line]!) out.push({ line, start: token.start, end: token.end, scopes: token.scopes })
  }
  return out
}
