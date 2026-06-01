import {
  CodeAction,
  CodeActionKind,
  Range,
  TextEdit,
  type Diagnostic,
} from 'vscode-languageserver/node.js'
import { djotMigrationWarnings, type MigrationWarning } from '@markup-carve/carve'

export interface MigrationFix {
  rule: string
  range: Range
  suggestion: string
}

export function migrationFixes(source: string): MigrationFix[] {
  return djotMigrationWarnings(source)
    .map((warning) => migrationFix(source, warning))
    .filter((fix): fix is MigrationFix => Boolean(fix))
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

  return actions
}

function migrationFix(source: string, warning: MigrationWarning): MigrationFix | null {
  const lineStarts = lineStartOffsets(source)
  const lineStart = lineStarts[warning.line - 1]
  if (lineStart === undefined) return null

  const start = lineStart + warning.column - 1
  const end = constructEnd(source, start, warning.rule)
  if (end === null || end <= start) return null

  return {
    rule: warning.rule,
    range: rangeFromOffsets(source, start, end),
    suggestion: warning.suggestion,
  }
}

function constructEnd(source: string, start: number, rule: string): number | null {
  const rest = source.slice(start)
  const patterns: Record<string, RegExp> = {
    'markdown-strong-double-star': /^\*\*(?!\s)(?:(?!\n[ \t]*\n)[^*])+?(?<!\s)\*\*/,
    'markdown-strikethrough-double-tilde': /^~~(?!\s)(?:(?!\n[ \t]*\n)[^~])+?(?<!\s)~~/,
    'djot-subscript-tilde': /^~(?!\s)(?:(?!\n[ \t]*\n)[^~])+?(?<!\s)~/,
    'djot-emphasis-underscore':
      /^_(?!\s)(?:(?!\n[ \t]*\n)[^_])+?(?<!\s)_(?![A-Za-z0-9_])/,
    'djot-highlight-braces': /^\{=(?!\s)(?:(?!\n[ \t]*\n)[\s\S])+?(?<!\s)=\}/,
  }
  const match = patterns[rule]?.exec(rest)
  return match ? start + match[0].length : null
}

function lineStartOffsets(source: string): number[] {
  const starts = [0]
  for (let index = 0; index < source.length; index++) {
    if (source[index] === '\n') starts.push(index + 1)
  }
  return starts
}

function rangeFromOffsets(source: string, start: number, end: number): Range {
  return Range.create(positionAt(source, start), positionAt(source, end))
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
