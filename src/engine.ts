/**
 * The one seam to the Carve 0.2 engine. Every module reads the engine through
 * here, so the server never mixes the 0.1 package root with the 0.2 API.
 *
 * Tree offsets and diagnostic ranges count UTF-8 bytes; `byteToIndex` turns
 * them into the string index an LSP position is computed from.
 */
export {
  parse,
  parseWithDiagnostics,
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
} from '@markup-carve/carve'
export { semanticSpan } from '@markup-carve/carve/extensions'
export { registerExports } from '@markup-carve/carve/export'
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
  IncludeOptions,
  LintOptions,
  ParseOptions,
  RenderOptions,
} from '@markup-carve/carve'
