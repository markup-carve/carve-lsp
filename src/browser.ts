/**
 * The analysis functions a browser editor can run in the page: no Node.js
 * built-in and no language-server transport. Include resolution stays off
 * unless the host passes a resolver (and `paths`) in `IncludeOptions`.
 * `tests/browser-entry.test.ts` holds this file's import graph to that.
 */
export { analyzeCarve, parseErrorRange, tolerantHeadingSymbols, type AnalyzeOptions, type Analysis } from './analyze.js'
export { completionAt } from './completion.js'
export { hoverAt } from './hover.js'
export { foldingRanges } from './folding.js'
export { selectionRanges } from './selection.js'
export { documentLinks } from './document-links.js'
export { documentHighlights } from './document-highlights.js'
export { referencesAt } from './references.js'
export { definitionAt } from './definition.js'
export { prepareRename, renameEdits } from './rename.js'
export { inlayHints } from './inlay-hints.js'
export { bareListMarkerHints } from './list-marker-hints.js'
export { formatDocument, formatRange, continuationPrefix, listContinuationEdits, listIndentEdits, type ContinuationEdit, type ListIndentDirection } from './format.js'
export { listDelim, listItems, bareMarkerItem } from './list-items.js'
export { lintCodeActions } from './lint-actions.js'
export { migrationFixes, migrationCodeActions } from './migration-actions.js'
export { tableDiagnostics } from './table-diagnostics.js'
export { codeLenses } from './codelens.js'
export { portableIncludePaths, type IncludePaths } from './include-paths.js'
