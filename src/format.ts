/*
 * Conservative Carve formatter.
 *
 * Carve source does not have a canonical serializer, and whitespace that looks
 * cosmetic can be structural: a second blank line detaches captions, trailing
 * blank lines can belong to an unclosed fence, and trailing spaces are content
 * in line blocks. Preserve every source byte except for adding a missing final
 * line ending, which is render-equivalent and keeps the formatter idempotent.
 */

export function formatDocument(source: string): string {
  if (source === '' || source.endsWith('\n')) return source
  return source + (source.includes('\r\n') ? '\r\n' : '\n')
}

export function formatRange(source: string, startLine: number, endLine: number): string {
  const eol = source.includes('\r\n') ? '\r\n' : '\n'
  return source.split(/\r?\n/).slice(startLine, endLine + 1).join(eol)
}

/** Prefix inserted after Enter for container-shaped lines. */
export function continuationPrefix(source: string, line: number): string {
  const previous = source.split(/\r?\n/)[line - 1] ?? ''
  const container = /^(\s*)(:{3,}) [^\s].*$/.exec(previous)
  if (container) return `\n${container[1]}${container[2]}`
  const quote = /^(\s*(?:> )+)/.exec(previous)
  if (quote) return quote[1]!
  const table = /^(\s*)\|/.exec(previous)
  if (table) return `${table[1]}| `
  // A description marker is a colon, a run of SPACES, then content. PART 2
  // (MARKER REQUIRES CONTENT, carve#1830, corpus 439) makes a colon followed by
  // only whitespace a paragraph, so there is no description to continue - and a
  // tab separator is not a marker either. The separator run sets the body's
  // content column (corpus 424), so the continuation is as wide as it is rather
  // than always two.
  const definition = /^([ \t]*)(: +)(?=\S)/.exec(previous)
  if (definition) return definition[1]! + ' '.repeat(definition[2]!.length)
  return ''
}
