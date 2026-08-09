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

export const DIRECTIVE_SCAN_RE =
  /\{\{\s+(?:"((?:\\.|[^"\\])*)"|\u201c([^\u201d]*)\u201d|([^#@}\s"\u201c]+))((?:\s+#[A-Za-z_][\w-]*)?)(.*?)\s+\}\}/g
export const DIRECTIVE_FULL_RE =
  /^\{\{\s+(?:"((?:\\.|[^"\\])*)"|\u201c([^\u201d]*)\u201d|([^#@}\s"\u201c]+))((?:\s+#[A-Za-z_][\w-]*)?)(.*?)\s+\}\}$/
const OPTION_RE = /^@([A-Za-z_][\w-]*):([^#@}\s]+)$/

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
    for (const part of rest.split(/\s+/)) {
      const opt = OPTION_RE.exec(part)
      const invalid = (): null => {
        // I1: an unrecognized (or malformed) option makes the directive
        // unresolvable - warning plus literal text, never a silent drop.
        if (part.startsWith('@')) onInvalidOption?.(part)
        return null
      }
      if (!opt) return invalid()
      const [, key, value] = opt
      if (key === 'lines') {
        const lm = /^([1-9]\d*)-([1-9]\d*)$/.exec(value!)
        if (!lm) return invalid()
        lines = { start: Number(lm[1]), end: Number(lm[2]) }
        if (lines.end < lines.start) return invalid()
      } else if (key === 'shift') {
        // I8: a signed integer or the literal "auto", never both forms.
        if (value === 'auto') shift = 'auto'
        else if (!/^[+-]?\d+$/.test(value!)) return invalid()
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
    if (!parsed) continue
    found.push({ ...parsed, start, end })
  }
  return found
}
