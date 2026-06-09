import {
  CodeAction,
  CodeActionKind,
  Range,
  TextEdit,
  type Diagnostic,
} from 'vscode-languageserver/node.js'
import { applyMigrationFixes, djotMigrationWarnings } from '@markup-carve/carve'

export interface MigrationFix {
  rule: string
  range: Range
  suggestion: string
}

// `MigrationWarning.start`/`end` are offsets into the line-ending-normalized
// source, so positions are computed against the same normalization.
function normalize(source: string): string {
  return source.replace(/\r\n?/g, '\n')
}

export function migrationFixes(source: string): MigrationFix[] {
  const norm = normalize(source)
  return djotMigrationWarnings(source).map((warning) => ({
    rule: warning.rule,
    range: Range.create(
      positionAt(norm, warning.start),
      positionAt(norm, warning.end),
    ),
    suggestion: warning.suggestion,
  }))
}

export function migrationCodeActions(
  uri: string,
  source: string,
  diagnostics: Diagnostic[],
): CodeAction[] {
  const fixes = migrationFixes(source)
  const actions: CodeAction[] = []

  for (const diagnostic of diagnostics) {
    if (typeof diagnostic.code !== 'string') continue
    const fix = fixes.find(
      (candidate) =>
        candidate.rule === diagnostic.code &&
        candidate.range.start.line === diagnostic.range.start.line &&
        candidate.range.start.character === diagnostic.range.start.character,
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
 * A single source action that rewrites every auto-fixable collision in the
 * document via `applyMigrationFixes`. Offered only when something would
 * change. Crossing (ambiguous) collisions are left in place; they keep their
 * per-diagnostic warning for manual review.
 */
export function migrationFixAllAction(
  uri: string,
  source: string,
): CodeAction | null {
  const { output, applied } = applyMigrationFixes(source)
  if (applied.length === 0) return null

  // The whole-document range. Computed on the normalized text, whose
  // per-line character offsets match the live document (line endings differ
  // only at line breaks, which positionAt never indexes into).
  const norm = normalize(source)
  const fullRange = Range.create(
    positionAt(norm, 0),
    positionAt(norm, norm.length),
  )
  const n = applied.length
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
