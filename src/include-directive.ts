/**
 * Recognition of processor-level `{{ … }}` include directives (PART 6 grammar,
 * PART 9 §19 rule I1).
 *
 * Kept separate from {@link ./includes.js} so consumers that only need to
 * RECOGNIZE a directive do not pull in the expander's file-system imports.
 *
 * The regular expressions and `parseDirective` mirror `src/include-directive.ts`
 * in the carve-js engine deliberately: one rule, one spelling. What is added
 * here is source-level scanning. The engine recognizes directives on
 * reassembled inline runs of a parsed AST; this server has no include-aware
 * engine to parse with (the pinned `@markup-carve/carve` predates the pass), so
 * it scans the raw document text and shields verbatim regions itself.
 */

export interface Directive {
  raw: string
  path: string
  section?: string
  lines?: { start: number; end: number }
  /** Literal signed offset, or "auto" to derive it from the include site. */
  shift: number | 'auto'
  /** 0-based start offset in the scanned source, inclusive. */
  start: number
  /** 0-based end offset in the scanned source, exclusive. */
  end: number
}

/**
 * A quoted run: its opening quote through the first unescaped matching one.
 * PART 4's `quoted_value` has both spellings, and each excludes only its own
 * quote, the backslash and the newline, so a `}}` between the quotes belongs to
 * the run rather than closing the directive (PART 6 closer clause,
 * markup-carve/carve#2013).
 */
const DQUOTED_RUN = String.raw`"(?:\\.|[^"\\\n])*?"`
const SQUOTED_RUN = String.raw`'(?:\\.|[^'\\\n])*?'`

/**
 * The option slot up to the closer, stepping OVER whole quoted runs. The two
 * lookaheads are the exact negation of the runs beside them, so at any position
 * either a run starts and only a run alternative is viable, or none does and
 * only the single-character one is. No position is reachable two ways, so the
 * lazy scan never backtracks across the alternation.
 */
const QUOTE_AWARE_OPTIONS = String.raw`(?:${DQUOTED_RUN}|${SQUOTED_RUN}|(?!${DQUOTED_RUN})(?!${SQUOTED_RUN})[^\n])*?`

const OPEN = String.raw`\{\{\s+`
const PATH = String.raw`(?:"((?:\\.|[^"\\])*)"|\u201c([^\u201d]*)\u201d|([^#@}\s"\u201c]+))`
const SECTION = String.raw`((?:\s+#[A-Za-z_][\w-]*)?)`
const CLOSE = String.raw`\s+\}\}`
const body = (options: string): string => `${OPEN}${PATH}${SECTION}(${options})${CLOSE}`

const QUOTE_AWARE_BODY = body(QUOTE_AWARE_OPTIONS)
/**
 * The fallback reading, tried only where the quote-aware one finds no closer at
 * all: an UNTERMINATED quote opens no run, so it must not pair with a quote that
 * lies PAST the closer and leave the whole token unrecognized. Section 19
 * forbids exactly one outcome, literal text with no diagnostic, and that is what
 * dropping this branch would produce for `{{ a @k:"x }} said "hi"`.
 */
const FIRST_PAIR_BODY = body(String.raw`.*?`)

export const DIRECTIVE_SCAN_RE = new RegExp(`(?:${QUOTE_AWARE_BODY})|(?:${FIRST_PAIR_BODY})`, 'g')
export const DIRECTIVE_FULL_RE = new RegExp(`^(?:${QUOTE_AWARE_BODY})$`)

const OPTION_KEY_RE = /^@([A-Za-z_][\w-]*):/

/**
 * The option slot split into `@key:value` parts on whitespace that falls
 * OUTSIDE a quoted value, so `@k:"a b"` stays one part. A run that never closes
 * is not a run, and its quote is an ordinary character.
 */
function splitOptions(rest: string): string[] {
  const parts: string[] = []
  let current = ''
  for (let i = 0; i < rest.length; i += 1) {
    const ch = rest[i]!
    if (ch === '"' || ch === "'") {
      const end = quotedRunEnd(rest, i)
      if (end !== -1) {
        current += rest.slice(i, end + 1)
        i = end
        continue
      }
    }
    if (/\s/.test(ch)) {
      if (current) parts.push(current)
      current = ''
      continue
    }
    current += ch
  }
  if (current) parts.push(current)
  return parts
}

/**
 * The end index of the quoted run opening at `from`, or -1 when the quote is
 * never closed on its line. A backslash escapes the next character.
 */
function quotedRunEnd(text: string, from: number): number {
  const quote = text[from]
  for (let i = from + 1; i < text.length; i += 1) {
    const ch = text[i]
    if (ch === '\n') return -1
    if (ch === '\\') {
      i += 1
      continue
    }
    if (ch === quote) return i
  }
  return -1
}

/**
 * One `attribute_value` (PART 4): a quoted run in either quote, else the bare
 * set. Returns the value with its quotes and escapes removed, or null when the
 * text is not one whole value.
 */
function readOptionValue(raw: string): string | null {
  if (raw === '') return null
  if (raw[0] === '"' || raw[0] === "'") {
    if (quotedRunEnd(raw, 0) !== raw.length - 1) return null
    return raw.slice(1, -1).replace(/\\(.)/g, '$1')
  }
  return /^[^#@}\s"'\u201c]+$/.test(raw) ? raw : null
}

function unescapeQuotedPath(value: string): string {
  return value.replace(/\\(["\\])/g, '$1')
}

/**
 * Parse one candidate directive token. Returns null when the token is not a
 * well-formed directive per I1 (a bad shape, or an unrecognized or malformed
 * option), in which case it stays ordinary text and `onInvalidOption` fires so
 * the caller can raise `include-unknown-option`.
 */
export function parseDirective(
  raw: string,
  onInvalidOption?: (part: string) => void,
): Omit<Directive, 'start' | 'end'> | null {
  const m = DIRECTIVE_FULL_RE.exec(raw)
  if (!m) return null
  const includePath = m[1] !== undefined ? unescapeQuotedPath(m[1]) : (m[2] ?? m[3]!)
  if (includePath === '') return null
  const sectionPart = m[4]?.trim()
  const section = sectionPart ? sectionPart.slice(1) : undefined
  let lines: Directive['lines']
  let shift: number | 'auto' = 0
  const rest = m[5]?.trim()
  if (rest) {
    for (const part of splitOptions(rest)) {
      const key = OPTION_KEY_RE.exec(part)
      const invalid = (): null => {
        // I1: an unrecognized (or malformed) option makes the directive
        // unresolvable - warning plus literal text, never a silent drop. The
        // part is reported as written, quotes and all, so the message names the
        // option the author typed.
        if (part.startsWith('@')) onInvalidOption?.(part)
        return null
      }
      if (!key) return invalid()
      const value = readOptionValue(part.slice(key[0].length))
      if (value === null) return invalid()
      if (key[1] === 'lines') {
        const lm = /^([1-9]\d*)-([1-9]\d*)$/.exec(value)
        if (!lm) return invalid()
        lines = { start: Number(lm[1]), end: Number(lm[2]) }
        if (lines.end < lines.start) return invalid()
      } else if (key[1] === 'shift') {
        // I8: a signed integer or the literal "auto", never both forms.
        if (value === 'auto') shift = 'auto'
        else if (!/^[+-]?\d+$/.test(value)) return invalid()
        else shift = Number(value)
      } else {
        return invalid()
      }
    }
  }
  const directive: Omit<Directive, 'start' | 'end'> = { raw, path: includePath, shift }
  if (section !== undefined) directive.section = section
  if (lines !== undefined) directive.lines = lines
  return directive
}

/**
 * Regions of `source` whose content is verbatim and therefore shielded from
 * include recognition (I9): fenced blocks of every flavour, raw blocks
 * (```` ```=html ````) included, and inline code spans.
 *
 * Approximate by design, and deliberately so: it is a line-and-backtick scan
 * rather than a parse, because the pinned engine cannot tell us where a
 * directive sits relative to a fence. It errs toward shielding - an ambiguous
 * region is treated as verbatim and the directive stays literal, which is the
 * safe direction for a file-read capability.
 */
export function verbatimSpans(source: string): Array<{ start: number; end: number }> {
  const spans: Array<{ start: number; end: number }> = []
  let offset = 0
  let fence: { char: string; length: number; start: number } | null = null

  for (const line of source.split('\n')) {
    const lineStart = offset
    const lineEnd = offset + line.length
    offset = lineEnd + 1

    if (fence) {
      const close = /^ {0,3}(`{3,}|~{3,})[ \t]*$/.exec(line)
      if (close && close[1]![0] === fence.char && close[1]!.length >= fence.length) {
        spans.push({ start: fence.start, end: lineEnd })
        fence = null
      }
      continue
    }

    const open = /^ {0,3}(`{3,}|~{3,})(.*)$/.exec(line)
    // A backtick fence's info string may not itself contain a backtick; a
    // tilde fence's may. Same rule the engines apply.
    if (open && !(open[1]![0] === '`' && open[2]!.includes('`'))) {
      fence = { char: open[1]![0]!, length: open[1]!.length, start: lineStart }
      continue
    }

    // Inline code spans, matched run-for-run within the line.
    const runs = /`+/g
    let openRun: { index: number; length: number } | null = null
    for (let m = runs.exec(line); m; m = runs.exec(line)) {
      if (!openRun) {
        openRun = { index: m.index, length: m[0].length }
        continue
      }
      if (m[0].length === openRun.length) {
        spans.push({ start: lineStart + openRun.index, end: lineStart + m.index + m[0].length })
        openRun = null
      }
    }
  }

  // An unterminated fence shields everything to the end of the document.
  if (fence) spans.push({ start: fence.start, end: source.length })
  return spans
}

/**
 * Locate the well-formed directives in `source`, in source order, skipping any
 * that begin inside a verbatim region (I9).
 *
 * `onInvalidOption` fires for a token of directive shape whose options do not
 * parse, so the caller can raise `include-unknown-option` on it.
 */
export function findDirectives(
  source: string,
  onInvalidOption?: (part: string, start: number, end: number) => void,
): Directive[] {
  const shielded = verbatimSpans(source)
  const inVerbatim = (index: number): boolean =>
    shielded.some((span) => index >= span.start && index < span.end)

  const re = new RegExp(DIRECTIVE_SCAN_RE.source, 'g')
  const found: Directive[] = []
  for (let m = re.exec(source); m; m = re.exec(source)) {
    const start = m.index
    const end = start + m[0].length
    if (inVerbatim(start)) continue
    const parsed = parseDirective(m[0], (part) => onInvalidOption?.(part, start, end))
    if (!parsed) {
      // A malformed token is ordinary text, so the scan RESUMES one character
      // in rather than past it. A quote left open by the malformed token can
      // otherwise pair with one inside a later directive and swallow it:
      // `{{ a.crv @k:"x }} {{ b.crv @shift:"2" }}` would lose `b.crv`
      // entirely. This is what the spec's engine-free reader does
      // (markup-carve/carve scripts/spec/include-directive.mjs).
      re.lastIndex = start + 1
      continue
    }
    found.push({ ...parsed, start, end })
  }
  return found
}
