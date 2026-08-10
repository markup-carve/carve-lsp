import { pathToFileURL } from 'node:url'
import { type Location, type Position } from 'vscode-languageserver/node.js'
import { findDirectives } from './include-directive.js'
import type { IncludeOptions } from './includes.js'

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
    range: {
      start: { line: 0, character: 0 },
      end: { line: 0, character: 0 },
    },
  }
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
