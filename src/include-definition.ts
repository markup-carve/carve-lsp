import { pathToFileURL } from 'node:url'
import { type Location, type Position } from 'vscode-languageserver/node.js'
import { findDirectives } from './include-directive.js'
import type { IncludeOptions } from './includes.js'

/**
 * Go-to-definition for an include directive: `{{ chapter-1.crv }}` to the file
 * it names.
 *
 * THE RESOLVER IS THE ONE IN include-path.ts, ALWAYS. Navigation needs the same
 * answer the include pass gets, and the tempting shortcut - joining the
 * directive path onto the document's directory here - would be a SECOND
 * resolution path. The two would be a security guard and a navigation feature
 * that can disagree about what is inside the contained root, which is how you
 * get a jump that happily opens a file the resolver refuses (PART 9 section 19
 * confines resolution to the project root after symlink resolution).
 *
 * So a DENIAL RETURNS null rather than a best-effort location. Refusing to
 * navigate is the correct answer for a target the resolver would not read: the
 * editor shows nothing, exactly as it does for any other unresolvable symbol.
 */
export function includeDefinitionAt(
  source: string,
  position: Position,
  options: IncludeOptions = {},
): Location | null {
  // Absent resolver means includes are off for this document (the default -
  // section 19 makes them opt-in). Nothing to navigate to.
  const resolver = options.resolver
  if (!resolver) return null

  // findDirectives works in offsets, so the cursor has to become one against
  // the SAME string it scans. Normalizing once and using the result for both is
  // what keeps a CRLF document from resolving the offset one byte per line off.
  const text = source.replace(/\r\n?/g, '\n')
  const offset = positionToOffset(text, position)
  if (offset === null) return null

  const directive = findDirectives(text).find((d) => offset >= d.start && offset < d.end)
  if (!directive) return null

  const resolved = resolver(directive.path, {
    sourcePath: options.sourcePath,
    stack: [],
    depth: 0,
  })
  if (!resolved.ok) return null

  // The child's own start. A `#section` selector could narrow this further, but
  // that means locating the heading inside a document this function has not
  // parsed; opening the file is the useful half and is what the selector-less
  // form wants anyway.
  return {
    uri: pathToFileURL(resolved.id).toString(),
    range: { start: { line: 0, character: 0 }, end: { line: 0, character: 0 } },
  }
}

/** LSP position to a 0-based offset in `text`, or null when out of range. */
function positionToOffset(text: string, position: Position): number | null {
  const lines = text.split('\n')
  if (position.line < 0 || position.line >= lines.length) return null
  let offset = 0
  for (let i = 0; i < position.line; i++) offset += (lines[i] as string).length + 1
  const line = lines[position.line] as string
  // A character past the end of the line clamps to the line end rather than
  // spilling into the next one.
  return offset + Math.min(position.character, line.length)
}
