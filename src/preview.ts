import { createWriterRegistry, parse, render } from './engine.js'
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

/** Raised when the export target has no writer in the installed engine yet. */
export class WriterNotAvailableError extends Error {
  constructor(readonly target: string) {
    super(`The ${target} writer is not available yet in Carve 0.2; it returns once the engine registers it.`)
    this.name = 'WriterNotAvailableError'
  }
}

/**
 * Markdown for the export action, with includes expanded like the preview.
 * Carve 0.2 writes Markdown through the writer registry (target `markdown`).
 */
export function previewMarkdown(source: string, includes?: IncludeOptions): string {
  const registry = createWriterRegistry()
  if (!registry.has('markdown')) throw new WriterNotAvailableError('markdown')
  const config = includes === undefined ? undefined : v2IncludeConfig(includes)
  const tree = config === undefined ? parse(source) : parse(source, { includes: config })
  return registry.write('markdown', tree).output
}
