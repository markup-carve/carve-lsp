import { portableIncludePaths } from './include-paths.js'
import { type Location, type Position, type Range } from 'vscode-languageserver-types'
import { parse } from './engine.js'
import { astOffsetToIndex } from './position.js'
import { lineCount, regionLines, sectionRange } from './include-selection.js'
import type { IncludeOptions as ServerIncludeOptions } from './includes.js'
import type { IncludeOptions } from './engine.js'
import { walkNodes } from './ast-walk.js'

const FILE_START: Range = {
  start: { line: 0, character: 0 },
  end: { line: 0, character: 0 },
}

export function includeDefinitionAt(
  source: string,
  position: Position,
  options: ServerIncludeOptions | undefined,
): Location | null {
  if (!options?.resolver) return null
  const normalized = source.replace(/\r\n?/g, '\n')
  const offset = offsetAt(normalized, position)
  const directive = directiveAt(normalized, offset)
  if (!directive) return null
  const stack = options.sourcePath === undefined ? [] : [options.sourcePath]
  const resolved = options.resolver(directive.path, {
    stack,
    depth: 0,
    ...(options.sourcePath === undefined ? {} : { sourcePath: options.sourcePath }),
  })
  if (!resolved.ok) return null
  return {
    uri: (options.paths ?? portableIncludePaths).toUri(resolved.id),
    range: selectionRange(directive, resolved.source),
  }
}

/**
 * Where in the child the jump lands.
 *
 * A directive that selects a section, a line range or a region names a PLACE,
 * and each is already parsed onto the directive - throwing them away and
 * landing on line 1 every time discards information the caller is holding. A selection
 * that does not resolve falls back to the top of the file rather than refusing
 * the jump: the file itself resolved, and `include-section` already reports
 * the bad selection as a diagnostic.
 */
function selectionRange(directive: Selection, source: string): Range {
  if (directive.section !== undefined) {
    return sectionRange(source, directive.section) ?? FILE_START
  }
  if (directive.lines !== undefined) {
    // A range starting past the end of the child has no line to land on, and
    // definition can be invoked independently of the diagnostic that reports
    // it, so the out-of-bounds position must not leave this function.
    if (directive.lines.start > lineCount(source)) return FILE_START
    return lineStart(directive.lines.start)
  }
  if (directive.region !== undefined) {
    const region = regionLines(source, directive.region, directive.code !== undefined)
    return region ? lineStart(region.start) : FILE_START
  }
  return FILE_START
}

function lineStart(oneBased: number): Range {
  const line = oneBased - 1
  return { start: { line, character: 0 }, end: { line, character: 0 } }
}

/** What a jump needs from a directive: the file and the place it selects. */
interface Selection {
  path: string
  section?: string
  lines?: { start: number; end: number }
  region?: string
  code?: boolean
}

/**
 * The directive the engine recognizes at `offset`; one in code, a comment or
 * other verbatim text is not one. The 0.2 tree keeps every directive as an
 * `include` node with its path, section and options (C2-A-181).
 */
function directiveAt(source: string, offset: number): Selection | null {
  let found: Selection | null = null
  try {
    walkNodes(parse(source), (node) => {
      if (found) return false
      if (node.type !== 'include' || !node.pos) return
      const start = astOffsetToIndex(source, node.pos.startOffset ?? 0)
      const end = astOffsetToIndex(source, node.pos.endOffset ?? 0)
      if (offset < start || offset >= end) return false
      const include = node as unknown as { path: string; section?: string; options?: IncludeOptions }
      const lines = /^(\d+)(?:-(\d+))?$/.exec(include.options?.lines ?? '')
      found = {
        path: include.path,
        ...(include.section === undefined ? {} : { section: include.section }),
        ...(lines ? { lines: { start: Number(lines[1]), end: Number(lines[2] ?? lines[1]) } } : {}),
        ...(include.options?.region === undefined ? {} : { region: include.options.region }),
        ...(include.options?.code === undefined ? {} : { code: true }),
      }
      return false
    })
  } catch {
    // A document that does not parse has no directives to follow.
  }
  return found
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
