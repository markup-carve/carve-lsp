import {
  CodeAction,
  CodeActionKind,
  Range,
  TextEdit,
  type Diagnostic,
} from 'vscode-languageserver-types'
import { fix, fixableRules, fixEdits, lint, type LintOptions } from './engine.js'
import { astOffsetToIndex } from './position.js'

export interface MigrationFix {
  rule: string
  /** What the fix replaces: its one edit, or the finding widened to every edit. */
  range: Range
  /** The text that replaces `range`. */
  suggestion: string
}

interface LocatedFix extends MigrationFix {
  /** Where the finding itself starts, which is what its diagnostic reports. */
  at: Range['start']
}

// Engine offsets count UTF-8 bytes of the line-ending-normalized source, so
// positions are computed against the same normalization.
function normalize(source: string): string {
  return source.replace(/\r\n?/g, '\n')
}

const FIXABLE_ON = Object.fromEntries(fixableRules.map((id) => [id, 'on'])) as LintOptions['rules']

function locatedFixes(source: string): LocatedFix[] {
  const norm = normalize(source)
  const at = (byte: number) => positionAt(norm, astOffsetToIndex(norm, byte))
  const bytes = new TextEncoder().encode(norm)
  const decoder = new TextDecoder()
  const fixes: LocatedFix[] = []
  for (const finding of lint(norm, { rules: FIXABLE_ON })) {
    if (finding.channel !== 'lint' || finding.file !== undefined || finding.range === undefined) continue
    const edits = fixEdits(norm, finding)
    if (edits === null || edits.length === 0) continue
    const range = finding.range
    const [only] = edits
    if (edits.length === 1 && only) {
      fixes.push({ rule: finding.code, range: Range.create(at(only.startOffset), at(only.endOffset)), suggestion: only.text, at: at(range.startOffset) })
      continue
    }
    const start = Math.min(range.startOffset, ...edits.map((edit) => edit.startOffset))
    const end = Math.max(range.endOffset, ...edits.map((edit) => edit.endOffset))
    let suggestion = ''
    let cursor = start
    for (const edit of [...edits].sort((a, b) => a.startOffset - b.startOffset)) {
      suggestion += decoder.decode(bytes.subarray(cursor, edit.startOffset)) + edit.text
      cursor = edit.endOffset
    }
    suggestion += decoder.decode(bytes.subarray(cursor, end))
    fixes.push({ rule: finding.code, range: Range.create(at(start), at(end)), suggestion, at: at(range.startOffset) })
  }
  return fixes
}

/** The fix of each finding of a fixable lint rule, every such rule on (as `carve lint --fix` runs them). */
export function migrationFixes(source: string): MigrationFix[] {
  return locatedFixes(source).map(({ rule, range, suggestion }) => ({ rule, range, suggestion }))
}

export function migrationCodeActions(
  uri: string,
  source: string,
  diagnostics: Diagnostic[],
): CodeAction[] {
  const fixes = locatedFixes(source)
  const actions: CodeAction[] = []

  for (const diagnostic of diagnostics) {
    if (typeof diagnostic.code !== 'string') continue
    const fix = fixes.find(
      (candidate) =>
        candidate.rule === diagnostic.code &&
        candidate.at.line === diagnostic.range.start.line &&
        candidate.at.character === diagnostic.range.start.character,
    )
    if (!fix) continue

    actions.push({
      title: `Convert to Carve syntax: ${fix.suggestion}`,
      kind: CodeActionKind.QuickFix,
      diagnostics: [diagnostic],
      edit: {
        changes: {
          [uri]: [TextEdit.replace(fix.range, fix.suggestion)],
        },
      },
      isPreferred: true,
    })
  }

  const fixAll = migrationFixAllAction(uri, source)
  if (fixAll) actions.push(fixAll)

  return actions
}

/**
 * A single source action that rewrites every auto-fixable finding in the
 * document, as `carve lint --fix` does. Offered only when something would
 * change. Ambiguous findings are left in place; they keep their per-diagnostic
 * warning for manual review.
 */
export function migrationFixAllAction(
  uri: string,
  source: string,
): CodeAction | null {
  const { output, applied } = fix(normalize(source))
  if (applied.size === 0) return null

  // The whole-document range. Computed on the normalized text, whose
  // per-line character offsets match the live document (line endings differ
  // only at line breaks, which positionAt never indexes into).
  const norm = normalize(source)
  const fullRange = Range.create(
    positionAt(norm, 0),
    positionAt(norm, norm.length),
  )
  const n = [...applied.values()].reduce((sum, count) => sum + count, 0)
  return {
    title: `Fix all Carve migration collisions (${n})`,
    kind: CodeActionKind.SourceFixAll,
    edit: {
      changes: {
        [uri]: [TextEdit.replace(fullRange, output)],
      },
    },
  }
}

function positionAt(source: string, offset: number) {
  const before = source.slice(0, offset)
  const line = before.split('\n').length - 1
  const lastNewline = before.lastIndexOf('\n')
  return {
    line,
    character: offset - lastNewline - 1,
  }
}
