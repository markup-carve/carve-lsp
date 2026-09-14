import { pathToFileURL } from 'node:url'
import { type Location, type Position, type Range } from 'vscode-languageserver/node.js'
import { findDirectives, type Directive } from './include-directive.js'
import { lineCount, sectionRange } from './include-selection.js'
import type { IncludeOptions } from './includes.js'

const FILE_START: Range = {
  start: { line: 0, character: 0 },
  end: { line: 0, character: 0 },
}

export function includeDefinitionAt(
  source: string,
  position: Position,
  options: IncludeOptions | undefined,
): Location | null {
  if (!options?.resolver) return null
  const normalized = source.replace(/\r\n?/g, '\n')
  const offset = offsetAt(normalized, position)
  const directive = findDirectives(normalized).find(
    (candidate) => offset >= candidate.start && offset < candidate.end,
  )
  if (!directive) return null
  const stack = options.sourcePath === undefined ? [] : [options.sourcePath]
  const resolved = options.resolver(directive.path, {
    stack,
    depth: 0,
    ...(options.sourcePath === undefined ? {} : { sourcePath: options.sourcePath }),
  })
  if (!resolved.ok) return null
  return {
    uri: pathToFileURL(resolved.id).toString(),
    range: selectionRange(directive, resolved.source),
  }
}

/**
 * Where in the child the jump lands.
 *
 * A directive that selects a section or a line range names a PLACE, and both
 * are already parsed onto the directive - throwing them away and landing on
 * line 1 every time discards information the caller is holding. A selection
 * that does not resolve falls back to the top of the file rather than refusing
 * the jump: the file itself resolved, and `include-section` already reports
 * the bad selection as a diagnostic.
 */
function selectionRange(directive: Directive, source: string): Range {
  if (directive.section !== undefined) {
    return sectionRange(source, directive.section) ?? FILE_START
  }
  if (directive.lines !== undefined) {
    // A range starting past the end of the child has no line to land on, and
    // definition can be invoked independently of the diagnostic that reports
    // it, so the out-of-bounds position must not leave this function.
    if (directive.lines.start > lineCount(source)) return FILE_START
    const line = directive.lines.start - 1
    return { start: { line, character: 0 }, end: { line, character: 0 } }
  }
  return FILE_START
}

function offsetAt(source: string, position: Position): number {
  let offset = 0
  for (let line = 0; line < position.line; line += 1) {
    const newline = source.indexOf('\n', offset)
    if (newline < 0) return source.length
    offset = newline + 1
  }
  return Math.min(source.length, offset + position.character)
}
