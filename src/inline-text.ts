/**
 * Shared inline-to-text fallback for the three plain-text walks (outline
 * symbols, cross-reference matching, go-to-definition).
 *
 * Carve represents a typographic substitution as a `smart_punctuation` inline
 * node rather than writing the glyph into the text buffer (carve spec PART 9
 * §8). The node carries the resolved `kind`, the author's source run in
 * `value`, and - for quotes, whose glyph is locale-dependent and chosen during
 * parsing - the resolved character in `glyph`.
 *
 * The walks here used if/else-if chains with no final branch, so a node type
 * they did not know about contributed nothing. That failed silently: every
 * quote, apostrophe, dash and ellipsis vanished from the extracted text, and
 * `# Don't repeat yourself` became `Dont repeat yourself` in outline symbols
 * and in the text a crossref resolves against.
 *
 * Preference order is `glyph`, then the source run. Resolving `kind` through
 * carve's glyph table would be marginally more faithful for dashes and
 * ellipses, but the table is not exported from the package root, and it does
 * not matter for what these walks feed: heading ids normalize typographic
 * output back to ASCII anyway, and the three walks stay consistent with each
 * other either way, which is what reference matching actually needs.
 */
export function smartPunctuationText(node: unknown): string {
  if (typeof node !== 'object' || node === null) return ''
  const candidate = node as { type?: unknown; glyph?: unknown; value?: unknown }
  if (candidate.type !== 'smart_punctuation') return ''
  if (typeof candidate.glyph === 'string') return candidate.glyph
  return typeof candidate.value === 'string' ? candidate.value : ''
}
