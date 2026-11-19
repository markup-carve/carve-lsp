import { createWriterRegistry, parse, registerExports, render } from './engine.js'
import { v2IncludeConfig, type IncludeOptions } from './includes.js'

/**
 * HTML for `carve.previewHtml`. With include options the preview renders the
 * expanded document, read through the same contained resolver the diagnostics
 * use; without them it is `render` of the source.
 */
export function previewHtml(source: string, includes?: IncludeOptions): string {
  const config = includes === undefined ? undefined : v2IncludeConfig(includes)
  return config === undefined ? render(source) : render(source, { includes: config })
}

/**
 * Markdown for the export action, with includes expanded like the preview.
 * Carve 0.2 writes Markdown through the writer registry (target `markdown`).
 */
export function previewMarkdown(source: string, includes?: IncludeOptions): string {
  const registry = registerExports(createWriterRegistry())
  const config = includes === undefined ? undefined : v2IncludeConfig(includes)
  const tree = config === undefined ? parse(source) : parse(source, { includes: config })
  return registry.write('markdown', tree).output
}
