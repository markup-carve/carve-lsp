/**
 * The rewrites of `carve lint --fix`: each lint finding whose catalog message
 * names one replacement is rewritten to it, and a fix stays only where its node
 * stands in the fixed source. A copy of carve-js `cli/fix.ts` at the pinned
 * commit, because no package entry exports it yet (markup-carve/carve-js#5086).
 * Byte offsets throughout, as the engine reports them; browser-safe (no Buffer).
 */
import { lint, parse, type EngineDiagnostic, type LintOptions } from './engine.js'

export interface FixEdit {
  /** UTF-8 byte offsets into the source. */
  start: number
  end: number
  text: string
}

interface Plan {
  edits: FixEdit[]
  /** The offset, in the source before the fix, that the node must cover after it. */
  at: number
  node: string
  /** The node starts at `at`, rather than only covering it. */
  starts: boolean
}

type Fixer = (bytes: Uint8Array, start: number, end: number) => Plan | null

const encoder = new TextEncoder()
const decoder = new TextDecoder()

function pair(open: string, close: string, replaceOpen: string, replaceClose: string, node: string): Fixer {
  return (bytes, start, end) => {
    const text = decoder.decode(bytes.subarray(start, end))
    if (end - start < open.length + close.length + 1 || !text.startsWith(open) || !text.endsWith(close)) return null
    return {
      edits: [{ start, end: start + open.length, text: replaceOpen }, { start: end - close.length, end, text: replaceClose }],
      at: start, node, starts: true,
    }
  }
}

function isBlank(byte: number | undefined): boolean {
  return byte === 0x20 || byte === 0x09
}

const closingHashes: Fixer = (bytes, start, end) => {
  let from = start
  while (isBlank(bytes[from - 1])) from--
  let to = end
  while (isBlank(bytes[to])) to++
  if (from === start) return null
  return { edits: [{ start: from, end: to, text: '' }], at: from, node: 'heading', starts: false }
}

const plusBullet: Fixer = (bytes, start) => (bytes[start] === 0x2b
  ? { edits: [{ start, end: start + 1, text: '-' }], at: start, node: 'list_item', starts: true }
  : null)

const thematicBreak: Fixer = (_bytes, start, end) => ({ edits: [{ start, end, text: '***' }], at: start, node: 'thematic_break', starts: true })

const FIXES: ReadonlyMap<string, Fixer> = new Map<string, Fixer>([
  ['markdown-strong-double-star', pair('**', '**', '*', '*', 'strong')],
  ['markdown-strikethrough-double-tilde', pair('~~', '~~', '{~', '~}', 'strike')],
  ['djot-emphasis-underscore', pair('_', '_', '/', '/', 'emphasis')],
  ['djot-intraword-underscore', pair('_', '_', '{/', '/}', 'emphasis')],
  ['djot-subscript-tilde', pair('~', '~', '{,', ',}', 'subscript')],
  ['djot-superscript-caret', pair('^', '^', '{^', '^}', 'superscript')],
  ['deprecated-bare-strike', pair('~', '~', '{~', '~}', 'strike')],
  ['deprecated-bare-highlight', pair('=', '=', '{=', '=}', 'highlight')],
  ['djot-plus-bullet', plusBullet],
  ['heading-closing-hashes', closingHashes],
  ['thematic-break-spelling', thematicBreak],
])

export interface FixCandidate {
  rule: string
  /** The finding's own byte range. */
  range: { startOffset: number; endOffset: number }
  edits: FixEdit[]
}

interface Candidate extends FixCandidate {
  plan: Plan
}

function sameEdits(left: Plan, right: Plan): boolean {
  return left.edits.length === right.edits.length &&
    left.edits.every((edit, index) => edit.start === right.edits[index]?.start && edit.end === right.edits[index]?.end &&
      edit.text === right.edits[index]?.text)
}

function overlaps(edit: FixEdit, taken: readonly FixEdit[]): boolean {
  return taken.some((other) => edit.start < other.end && other.start < edit.end)
}

/** Two rules that report one range with different replacements leave it to the author. */
function candidates(bytes: Uint8Array, entries: readonly EngineDiagnostic[]): Candidate[] {
  const byRange = new Map<string, Candidate[]>()
  for (const entry of entries) {
    const fixer = FIXES.get(entry.code)
    if (fixer === undefined || entry.channel !== 'lint' || entry.file !== undefined || entry.range === undefined) continue
    const plan = fixer(bytes, entry.range.startOffset, entry.range.endOffset)
    if (plan === null) continue
    const key = `${entry.range.startOffset}:${entry.range.endOffset}`
    byRange.set(key, [...(byRange.get(key) ?? []), { rule: entry.code, range: entry.range, edits: plan.edits, plan }])
  }
  const result: Candidate[] = []
  for (const group of byRange.values()) {
    if (group.every((candidate) => sameEdits(candidate.plan, group[0]!.plan))) result.push(group[0]!)
  }
  return result
}

function select(found: readonly Candidate[]): Candidate[] {
  const taken: FixEdit[] = []
  const chosen: Candidate[] = []
  for (const candidate of [...found].sort((a, b) => a.plan.at - b.plan.at)) {
    if (candidate.plan.edits.some((edit) => overlaps(edit, taken))) continue
    taken.push(...candidate.plan.edits)
    chosen.push(candidate)
  }
  return chosen
}

function concat(parts: readonly Uint8Array[]): Uint8Array {
  const out = new Uint8Array(parts.reduce((sum, part) => sum + part.length, 0))
  let at = 0
  for (const part of parts) {
    out.set(part, at)
    at += part.length
  }
  return out
}

function apply(bytes: Uint8Array, chosen: readonly Candidate[]): Uint8Array {
  const edits = chosen.flatMap((candidate) => candidate.plan.edits).sort((a, b) => a.start - b.start)
  const parts: Uint8Array[] = []
  let at = 0
  for (const edit of edits) {
    parts.push(bytes.subarray(at, edit.start), encoder.encode(edit.text))
    at = edit.end
  }
  parts.push(bytes.subarray(at))
  return concat(parts)
}

function mapped(offset: number, chosen: readonly Candidate[]): number {
  let shift = 0
  for (const candidate of chosen) {
    for (const edit of candidate.plan.edits) {
      if (edit.end <= offset && edit.start < offset) shift += encoder.encode(edit.text).length - (edit.end - edit.start)
    }
  }
  return offset + shift
}

interface Span { type: string; start: number; end: number }

function spans(bytes: Uint8Array): Span[] {
  const result: Span[] = []
  let tree: unknown
  try {
    tree = parse(decoder.decode(bytes), { positions: true })
  } catch {
    return result
  }
  const pending: unknown[] = [tree]
  for (let node = pending.pop(); node !== undefined; node = pending.pop()) {
    if (typeof node !== 'object' || node === null) continue
    const record = node as Record<string, unknown>
    const pos = record['pos'] as { startOffset: number; endOffset: number } | undefined
    if (typeof record['type'] === 'string' && pos !== undefined) result.push({ type: record['type'], start: pos.startOffset, end: pos.endOffset })
    for (const value of Object.values(record)) if (Array.isArray(value)) pending.push(...(value as unknown[]))
  }
  return result
}

/** A fix holds only where its node stands in the fixed source; the others are left for the author. */
function verified(bytes: Uint8Array, chosen: readonly Candidate[]): Candidate[] {
  let kept = [...chosen]
  for (let round = 0; round < 4 && kept.length > 0; round++) {
    const found = spans(apply(bytes, kept))
    const holding = kept.filter((candidate) => {
      const at = mapped(candidate.plan.at, kept)
      return found.some((span) => span.type === candidate.plan.node &&
        (candidate.plan.starts ? span.start === at : span.start <= at && at <= span.end))
    })
    if (holding.length === kept.length) return kept
    kept = holding
  }
  return []
}

/** Every fixable rule on, unless `rules` turns it off. */
function fixOptions(rules: LintOptions['rules'] | undefined): LintOptions {
  const all: Record<string, 'on' | 'off'> = {}
  for (const id of FIXES.keys()) all[id] = 'on'
  return { rules: { ...all, ...rules } as LintOptions['rules'] }
}

/** The fix of each finding that verifies on its own, every fixable rule on unless `rules` turns it off. */
export function fixCandidates(source: string, rules?: LintOptions['rules']): FixCandidate[] {
  const bytes = encoder.encode(source)
  return candidates(bytes, lint(source, fixOptions(rules)))
    .filter((candidate) => verified(bytes, [candidate]).length === 1)
    .map(({ rule, range, edits }) => ({ rule, range, edits }))
}

export interface FixResult {
  output: string
  /** The fixes applied, by rule. */
  applied: Map<string, number>
}

const MAX_PASSES = 10

/** The source with every fix applied that verifies, pass after pass until a pass changes nothing. */
export function fixSource(source: string, rules?: LintOptions['rules']): FixResult {
  const settings = fixOptions(rules)
  const applied = new Map<string, number>()
  let bytes: Uint8Array = encoder.encode(source)
  let changed = false
  for (let pass = 0; pass < MAX_PASSES; pass++) {
    const chosen = verified(bytes, select(candidates(bytes, lint(decoder.decode(bytes), settings))))
    if (chosen.length === 0) break
    bytes = apply(bytes, chosen)
    changed = true
    for (const candidate of chosen) applied.set(candidate.rule, (applied.get(candidate.rule) ?? 0) + 1)
  }
  return { output: changed ? decoder.decode(bytes) : source, applied }
}
