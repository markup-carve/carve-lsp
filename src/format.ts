/*
 * Conservative Carve formatter.
 *
 * Carve has no canonical source serializer, so this does not reflow content.
 * It only applies safe, idempotent normalizations OUTSIDE verbatim blocks
 * (fenced code, raw blocks, comment blocks):
 *   - strip trailing whitespace
 *   - collapse runs of 2+ blank lines to a single blank line
 *   - trim leading/trailing blank lines
 *   - end the file with exactly one newline
 *
 * Verbatim block interiors are emitted byte-for-byte (only the file-final
 * newline is enforced), so code, raw HTML, and comments are never altered.
 */

export function formatDocument(source: string): string {
  const eol = source.includes('\r\n') ? '\r\n' : '\n'
  const lines = source.split(/\r?\n/)
  const out: string[] = []
  let openFence: string | null = null
  let blankRun = 0

  for (const raw of lines) {
    if (openFence !== null) {
      out.push(raw)
      if (closesFence(raw, openFence)) openFence = null
      blankRun = 0
      continue
    }

    const opener = fenceOpener(raw)
    if (opener) {
      openFence = opener
      out.push(raw.replace(/[ \t]+$/, ''))
      blankRun = 0
      continue
    }

    const trimmed = raw.replace(/[ \t]+$/, '')
    if (trimmed === '') {
      blankRun++
      if (blankRun === 1) out.push('')
      continue
    }
    blankRun = 0
    out.push(trimmed)
  }

  while (out.length && out[0] === '') out.shift()
  while (out.length && out[out.length - 1] === '') out.pop()

  return out.length ? out.join(eol) + eol : ''
}

/**
 * A verbatim block opener: a fence marker indented at most three spaces.
 * Backtick fences cannot carry a backtick in the info string, and a comment
 * fence (`%%%`) must stand alone (no info), matching the parser.
 */
function fenceOpener(line: string): string | null {
  const match = /^( {0,3})(`{3,}|~{3,}|%{3,})(.*)$/.exec(line)
  if (!match) return null
  const marker = match[2]!
  const info = match[3]!
  if (marker[0] === '`' && info.includes('`')) return null
  if (marker[0] === '%' && info.trim() !== '') return null
  return marker
}

/**
 * A verbatim block closes on a lone fence (indent <= 3) of the same char.
 * Comment blocks close only on an exact-length marker; code/raw fences close
 * on a marker at least as long as the opener (CommonMark rule).
 */
function closesFence(line: string, openFence: string): boolean {
  const match = /^ {0,3}(`{3,}|~{3,}|%{3,})[ \t]*$/.exec(line)
  if (!match) return false
  const close = match[1]!
  if (close[0] !== openFence[0]) return false
  return openFence[0] === '%' ? close.length === openFence.length : close.length >= openFence.length
}
