import { carveToHtml, renderDocument } from '@markup-carve/carve'
import { resolveIncludes, type IncludeOptions } from './includes.js'

/**
 * HTML for `carve.previewHtml`. With include options the preview renders the
 * merged document, read through the same contained resolver and bounds the
 * diagnostics use; without them it is `carveToHtml` of the source.
 */
export function previewHtml(source: string, includes?: IncludeOptions): string {
  if (includes === undefined) return carveToHtml(source)
  const expanded = resolveIncludes(source, includes).expanded
  return expanded === undefined ? carveToHtml(source) : renderDocument(expanded)
}
