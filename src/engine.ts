/**
 * The one seam to the Carve 0.2 engine. Every module reads the engine through
 * here, so the server never mixes the 0.1 package root with the 0.2 API.
 *
 * Tree offsets and diagnostic ranges count UTF-8 bytes; `byteToIndex` turns
 * them into the string index an LSP position is computed from.
 */
import { parse as parseTree, parseWithDiagnostics as parseTreeWithDiagnostics, type DocumentNode, type ParseOptions } from '@markup-carve/carve/v2'
import { trimAttributeLines } from './block-positions.js'

/** `parse` with each block position starting at the block's own line, not its attribute lines. */
export function parse(source: string, options?: ParseOptions): DocumentNode {
  return trimAttributeLines(parseTree(source, options), source)
}

export function parseWithDiagnostics(source: string, options?: ParseOptions): ReturnType<typeof parseTreeWithDiagnostics> {
  const result = parseTreeWithDiagnostics(source, options)
  trimAttributeLines(result.document, source)
  return result
}

export { parseTree }

export {
  render,
  renderWithDiagnostics,
  format,
  formatWithDiagnostics,
  lint,
  includeDependencies,
  encodeTree,
  createWriterRegistry,
  stringOffsetOfByte,
  utf8Length,
  CarveOptionError,
  RESERVED_WRITER_TARGETS,
} from '@markup-carve/carve/v2'
export type {
  DocumentNode as Document,
  Block as BlockNode,
  Inline as InlineNode,
  HeadingNode as Heading,
  CaptionNode,
  Position,
  Diagnostic as EngineDiagnostic,
  IncludeResolver,
  IncludeRequest,
  IncludeAnswer,
  IncludeConfig,
  LintOptions,
  ParseOptions,
  RenderOptions,
} from '@markup-carve/carve/v2'
