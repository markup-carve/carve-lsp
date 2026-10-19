#!/usr/bin/env node
import {
  CodeActionKind,
  CodeActionRequest,
  CodeActionResolveRequest,
  CodeLensRequest,
  CompletionRequest,
  createConnection,
  DefinitionRequest,
  DocumentDiagnosticReportKind,
  DocumentFormattingRequest,
  DocumentHighlightRequest,
  DocumentLinkRequest,
  DocumentOnTypeFormattingRequest,
  DocumentRangeFormattingRequest,
  DocumentSymbolRequest,
  ExecuteCommandRequest,
  FoldingRangeRequest,
  FileChangeType,
  HoverRequest,
  InlayHintRequest,
  LinkedEditingRangeRequest,
  PrepareRenameRequest,
  ProposedFeatures,
  ReferencesRequest,
  DidChangeConfigurationNotification,
  DidChangeWatchedFilesNotification,
  RenameRequest,
  SemanticTokensBuilder,
  SelectionRangeRequest,
  TextDocuments,
  TextDocumentSyncKind,
  WorkspaceSymbolRequest,
  type Disposable,
  type DocumentSymbol,
  type SymbolInformation,
  type TextEdit,
} from 'vscode-languageserver/node.js'
import { TextDocument } from 'vscode-languageserver-textdocument'
import { carveToCarve } from '@markup-carve/carve'
import { analyzeCarve, type Analysis } from './analyze.js'
import { previewHtml, previewMarkdown } from './preview.js'
import { EXPORT_KIND, exportCodeActions, exportSupport, resolveExportAction, type ExportFormat, type ExportSupport } from './export-actions.js'
import {
  DEFAULT_INCLUDE_SETTINGS,
  fsPath,
  includeOptionsFor,
  previewIncludeOptionsFor,
  type IncludeGateInput,
  readIncludeSettings,
  readWorkspaceTrusted,
  type IncludeSettings,
} from './include-settings.js'
import { definitionAt } from './definition.js'
import { referencesAt } from './references.js'
import { codeLenses } from './codelens.js'
import { completionAt } from './completion.js'
import { foldingRanges } from './folding.js'
import { continuationEdits, formatDocument, formatRange, listContinuationEdits, listIndentEdits } from './format.js'
import { alignTableCodeAction, alignTablesInDocument, tableAlignmentEdits } from './table-alignment.js'
import { hoverAt } from './hover.js'
import { migrationCodeActions } from './migration-actions.js'
import { lintCodeActions } from './lint-actions.js'
import { prepareRename, renameEdits } from './rename.js'
import { DiagnosticScheduler } from './diagnostic-scheduler.js'
import { IncludeParseCache, IncludeSourceCache } from './include-cache.js'
import { DependencyIndex, watcherFor } from './dependencies.js'
import {
  buildSemanticTokens,
  buildSemanticTokensRange,
  semanticTokenModifiers,
  semanticTokenTypes,
  updateSemanticTokens,
} from './semantic.js'
import { documentLinks } from './document-links.js'
import { documentHighlights } from './document-highlights.js'
import { inlayHints } from './inlay-hints.js'
import { bareListMarkerHints, editedLine } from './list-marker-hints.js'
import { selectionRanges } from './selection.js'
import { WorkspaceIndex } from './workspace-index.js'
import { backlinks, generatedNavigation, rebuildImpact, workspaceGraph } from './workspace-graph.js'
import { indexWorkspace } from './workspace-loader.js'
import { readFileSync, realpathSync, statSync } from 'node:fs'
import { VersionedCache } from './versioned-cache.js'
import { includeCompletions } from './include-completion.js'
import { carveSection, DEFAULT_CARVE_SETTINGS, mergeCarveSettings, readProjectSection, type CarveSettings } from './settings.js'
import { colonFenceInlayHints, linkedColonFenceRanges } from './colon-fences.js'

const connection = createConnection(ProposedFeatures.all)
// The last line each document was edited on, from didChange ranges. The
// bare-marker hint is scoped to it, since inlay requests carry no cursor.
const editedLines = new Map<string, number>()
const documents = new TextDocuments({
  create: TextDocument.create,
  update: (document, changes, version) => {
    const line = editedLine(changes)
    if (line === undefined) editedLines.delete(document.uri)
    else editedLines.set(document.uri, line)
    return TextDocument.update(document, changes, version)
  },
})

let includeSettings: IncludeSettings = DEFAULT_INCLUDE_SETTINGS
let carveSettings: CarveSettings = DEFAULT_CARVE_SETTINGS
let workspaceTrusted = false
let exportClient: ExportSupport = { createFile: false, resolveEdit: false }
let workspaceRoots: string[] = []
// The last `carve` section the client sent; its keys override `.carverc.json` one by one.
let clientCarveSection: Record<string, unknown> | undefined
let semanticTokensRefreshSupported = false
const includeCache = new IncludeSourceCache()
const includeParseCache = new IncludeParseCache()
const dependencyIndex = new DependencyIndex()
const workspaceIndex = new WorkspaceIndex()
const semanticBuilders = new Map<string, SemanticTokensBuilder>()
const analysisCache = new VersionedCache<Analysis>()
let watcherRegistration: Disposable | undefined
let watcherRefresh = Promise.resolve()

function resolveCarveSettings(): CarveSettings {
  return mergeCarveSettings(clientCarveSection, readProjectSection(workspaceRoots) ?? undefined)
}

function sameExtensions(left: readonly string[], right: readonly string[]): boolean {
  return left.length === right.length && left.every((name, index) => name === right[index])
}

/**
 * Say so when a configured `includeRoot` was dropped. A root the client
 * believes is in force but which the server ignored is exactly the kind of
 * silent disagreement §19 containment should never have.
 */
function logIncludeSettings(message: string): void {
  connection.console.warn(message)
}

connection.onInitialize((params) => {
  semanticTokensRefreshSupported = params.capabilities.workspace?.semanticTokens?.refreshSupport === true
  includeSettings = readIncludeSettings(params.initializationOptions, logIncludeSettings)
  workspaceTrusted = readWorkspaceTrusted(params.initializationOptions)
  exportClient = exportSupport(params.capabilities)
  // Every folder, not just the first: a multi-root session roots each document
  // at the folder it actually lives in.
  const folders = (params.workspaceFolders ?? []).map((folder) => fsPath(folder.uri))
  const legacyRoot = params.rootUri != null ? fsPath(params.rootUri) : undefined
  workspaceRoots = [...folders, legacyRoot].filter((root): root is string => root !== undefined)
  clientCarveSection = carveSection(params.initializationOptions)
  carveSettings = resolveCarveSettings()

  return {
    capabilities: {
      textDocumentSync: TextDocumentSyncKind.Incremental,
      documentSymbolProvider: true,
      workspaceSymbolProvider: true,
      hoverProvider: true,
      codeActionProvider: {
        codeActionKinds: [CodeActionKind.QuickFix, CodeActionKind.SourceFixAll, CodeActionKind.RefactorRewrite, EXPORT_KIND],
        resolveProvider: true,
      },
      documentFormattingProvider: true,
      documentRangeFormattingProvider: true,
      documentOnTypeFormattingProvider: { firstTriggerCharacter: '\n' },
      foldingRangeProvider: true,
      definitionProvider: true,
      documentLinkProvider: { resolveProvider: false },
      documentHighlightProvider: true,
      linkedEditingRangeProvider: true,
      selectionRangeProvider: true,
      inlayHintProvider: true,
      executeCommandProvider: { commands: [
        'carve.previewHtml', 'carve.showAst', 'carve.workspaceGraph',
        'carve.backlinks', 'carve.generatedNavigation', 'carve.rebuildImpact',
        'carve.listIndent',
      ] },
      referencesProvider: true,
      renameProvider: { prepareProvider: true },
      codeLensProvider: { resolveProvider: false },
      completionProvider: {
        triggerCharacters: [':', '#', '^', '[', '@', '{'],
      },
      semanticTokensProvider: {
        legend: {
          tokenTypes: [...semanticTokenTypes],
          tokenModifiers: [...semanticTokenModifiers],
        },
        full: { delta: true },
        range: true,
      },
      diagnosticProvider: {
        identifier: 'carve',
        interFileDependencies: true,
        workspaceDiagnostics: true,
      },
    },
  }
})

// A client may refuse a registration; the server keeps serving without it.
function warnUnregistered(what: string): (error: unknown) => void {
  return (error) => connection.console.warn(`Could not register ${what}: ${String(error)}`)
}

connection.onInitialized(() => {
  connection.client.register(DidChangeConfigurationNotification.type, undefined)
    .catch(warnUnregistered('configuration change notifications'))
  const loaded = indexWorkspace(workspaceIndex, workspaceRoots)
  if (loaded.truncated) connection.console.warn(`Carve workspace index stopped at ${loaded.files} files / ${loaded.bytes} bytes.`)
  connection.client.register(DidChangeWatchedFilesNotification.type, {
    watchers: [{ globPattern: '**/*.crv' }, { globPattern: '**/.carverc.json' }],
  }).catch(warnUnregistered('file watchers'))
})

connection.onDidChangeConfiguration((change) => {
  const previousExtensions = carveSettings.extensions
  // `settings: null` (sent by vscode-languageclient on any settings change)
  // carries nothing, so it keeps what the client sent before; an object
  // without a `carve` section clears it.
  if (change.settings != null) {
    includeSettings = readIncludeSettings(change.settings, logIncludeSettings)
    clientCarveSection = carveSection(change.settings)
  }
  carveSettings = resolveCarveSettings()
  if (semanticTokensRefreshSupported && !sameExtensions(previousExtensions, carveSettings.extensions)) {
    connection.languages.semanticTokens.refresh()
  }
  analysisCache.clear()
  // Coalesced: a settings change can arrive alongside others, and revalidating
  // every open document synchronously is the same cost this ticket is removing.
  for (const document of documents.all()) diagnostics.schedule(document.uri, document.version)
})

/**
 * Analysis is whole-document, so a burst of keystrokes must produce ONE run
 * rather than one per edit (markup-carve/carve-lsp#68). The scheduler always
 * hands back the newest version, and the document is re-read here, so
 * diagnostics for a superseded version are never published.
 */
const diagnostics = new DiagnosticScheduler({
  run: (uri) => {
    const document = documents.get(uri)
    // Closed between the last edit and the run: nothing to publish, and the
    // close handler has already cleared its diagnostics.
    if (document === undefined) return
    validate(document)
  },
})

// Open is not a burst, and waiting out a window nobody is typing in is pure
// latency, so it runs straight away.
documents.onDidOpen((event) => {
  workspaceIndex.update(event.document.uri, event.document.getText(), event.document.version)
  invalidateIncludedParse(event.document.uri)
  diagnostics.flush(event.document.uri, event.document.version)
  revalidateIncludingDocuments(event.document.uri)
})
documents.onDidChangeContent((event) => {
  workspaceIndex.update(event.document.uri, event.document.getText(), event.document.version)
  diagnostics.schedule(event.document.uri, event.document.version)
  revalidateIncludingDocuments(event.document.uri)
})
documents.onDidClose((event) => {
  editedLines.delete(event.document.uri)
  diagnostics.cancel(event.document.uri)
  // Closing an editor buffer must not make an on-disk workspace document
  // disappear from cross-file navigation.
  const target = fsPath(event.document.uri)
  try {
    if (!target) throw new Error('not a file URI')
    workspaceIndex.update(event.document.uri, readFileSync(target, 'utf8'), `disk:${statSync(target).mtimeMs}`)
  } catch {
    workspaceIndex.remove(event.document.uri)
  }
  analysisCache.remove(event.document.uri)
  invalidateIncludedParse(event.document.uri)
  semanticBuilders.delete(event.document.uri)
  if (dependencyIndex.remove(event.document.uri)) refreshWatchers()
  connection.sendDiagnostics({ uri: event.document.uri, diagnostics: [] })
  revalidateIncludingDocuments(event.document.uri)
})

connection.onDidChangeWatchedFiles((params) => {
  const affected = new Set<string>()
  for (const change of params.changes) {
    const target = fsPath(change.uri)
    if (target === undefined) continue
    includeCache.invalidate(target)
    includeParseCache.invalidate(target)
    if (target.endsWith('.carverc.json')) {
      const previousExtensions = carveSettings.extensions
      carveSettings = resolveCarveSettings()
      if (semanticTokensRefreshSupported && !sameExtensions(previousExtensions, carveSettings.extensions)) {
        connection.languages.semanticTokens.refresh()
      }
      analysisCache.clear()
      for (const document of documents.all()) diagnostics.schedule(document.uri, document.version)
    }
    if (change.uri.endsWith('.crv') && !documents.get(change.uri)) {
      if (change.type === FileChangeType.Deleted) workspaceIndex.remove(change.uri)
      else {
        try {
          workspaceIndex.update(change.uri, readFileSync(target, 'utf8'), `disk:${statSync(target).mtimeMs}`)
        } catch { workspaceIndex.remove(change.uri) }
      }
    }
    for (const uri of dependencyIndex.documentsFor(target)) affected.add(uri)
  }
  for (const uri of affected) {
    const document = documents.get(uri)
    if (document) {
      analysisCache.remove(uri)
      validate(document)
    }
  }
})

connection.onRequest(DocumentSymbolRequest.type, (params) => {
  const document = documents.get(params.textDocument.uri)
  if (!document) return []
  const includes = includeOptions(document)
  const analysis = analysisFor(document, includes)
  return analysis.includedSymbols.length > 0
    ? [...flattenSymbols(analysis.symbols, document.uri), ...analysis.includedSymbols]
    : analysis.symbols
})

connection.onRequest(WorkspaceSymbolRequest.type, (params) => workspaceIndex.symbols(params.query))

connection.languages.diagnostics.on((params) => {
  const document = documents.get(params.textDocument.uri)
  return {
    kind: DocumentDiagnosticReportKind.Full,
    items: document ? analysisFor(document).diagnostics : [],
  }
})

connection.languages.diagnostics.onWorkspace(() => ({
  items: workspaceIndex.documents().map((document) => ({
    uri: document.uri,
    version: null,
    kind: DocumentDiagnosticReportKind.Full,
    items: workspaceIndex.diagnostics(document.uri),
  })),
}))

connection.onRequest(DocumentLinkRequest.type, (params) => {
  const document = documents.get(params.textDocument.uri)
  return document ? documentLinks(document.uri, document.getText()) : []
})

connection.onRequest(DocumentHighlightRequest.type, (params) => {
  const document = documents.get(params.textDocument.uri)
  return document ? documentHighlights(document.uri, document.getText(), params.position) : []
})

connection.onRequest(SelectionRangeRequest.type, (params) => {
  const document = documents.get(params.textDocument.uri)
  return document ? selectionRanges(document.uri, document.getText(), params.positions) : []
})

connection.onRequest(InlayHintRequest.type, (params) => {
  if (!carveSettings.inlayHints) return []
  const document = documents.get(params.textDocument.uri)
  if (!document) return []
  const source = document.getText()
  return [
    ...inlayHints(source, params.range),
    ...colonFenceInlayHints(source, params.range),
    ...(carveSettings.bareListMarkerHints ? bareListMarkerHints(source, editedLines.get(document.uri), params.range) : []),
  ]
})

connection.onRequest(LinkedEditingRangeRequest.type, (params) => {
  const document = documents.get(params.textDocument.uri)
  return document ? linkedColonFenceRanges(document.getText(), params.position) : null
})

connection.onRequest(ExecuteCommandRequest.type, async (params) => {
  if (params.command === 'carve.listIndent') return listIndent(params.arguments?.[0])
  const uri = typeof params.arguments?.[0] === 'string' ? params.arguments[0] : undefined
  if (params.command === 'carve.workspaceGraph') return workspaceGraph(workspaceIndex)
  if (params.command === 'carve.backlinks') return uri ? backlinks(workspaceIndex, uri) : []
  if (params.command === 'carve.generatedNavigation') return generatedNavigation(workspaceIndex, uri)
  if (params.command === 'carve.rebuildImpact') return uri ? rebuildImpact(workspaceIndex, uri) : []
  const document = uri ? documents.get(uri) : undefined
  if (!document) return null
  const engine = await import('@markup-carve/carve')
  if (params.command === 'carve.previewHtml') return previewHtml(document.getText(), previewIncludeOptions(document))
  if (params.command === 'carve.showAst') return engine.carveToAstJson(document.getText())
  return null
})

/**
 * `carve.listIndent` with `{ uri, line, direction }`: the edits for that
 * document, which the host applies (several lines as one undo step), or null
 * when there is nothing to do and the host should run its own Tab.
 */
function listIndent(args: unknown): TextEdit[] | null {
  const { uri, line, direction } = (args ?? {}) as { uri?: unknown; line?: unknown; direction?: unknown }
  if (typeof uri !== 'string' || typeof line !== 'number' || (direction !== 'indent' && direction !== 'outdent')) return null
  const document = documents.get(uri)
  return document ? listIndentEdits(document.getText(), line, direction) : null
}

connection.onRequest(HoverRequest.type, (params) => {
  const document = documents.get(params.textDocument.uri)
  return document ? hoverAt(document.getText(), params.position) : null
})

connection.onRequest(CodeActionRequest.type, (params) => {
  const document = documents.get(params.textDocument.uri)
  return document
    ? [
        ...migrationCodeActions(params.textDocument.uri, document.getText(), params.context.diagnostics),
        ...lintCodeActions(params.textDocument.uri, document.getText(), params.context.diagnostics),
        ...(!params.context.only || params.context.only.some(kind => CodeActionKind.RefactorRewrite === kind || CodeActionKind.RefactorRewrite.startsWith(kind + '.'))
          ? [alignTableCodeAction(params.textDocument.uri, document.getText(), params.range.start.line)].filter(action => action !== null)
          : []),
        ...(carveSettings.exportActions ? exportCodeActions(params.textDocument.uri, exportClient, params.context.only, (format) => renderExport(document, format), readExportTarget) : []),
      ]
    : []
})

connection.onRequest(CodeActionResolveRequest.type, (action) =>
  resolveExportAction(action, (uri, format) => {
    const document = documents.get(uri)
    return document ? renderExport(document, format) : null
  }, readExportTarget),
)

function readExportTarget(target: string): string | null {
  const path = fsPath(target)
  if (!path) return null
  try {
    return readFileSync(path, 'utf8')
  } catch {
    return null
  }
}

function renderExport(document: TextDocument, format: ExportFormat): string {
  const includes = previewIncludeOptions(document)
  return format === 'html' ? previewHtml(document.getText(), includes) : previewMarkdown(document.getText(), includes)
}

connection.onRequest(CompletionRequest.type, (params) => {
  const document = documents.get(params.textDocument.uri)
  return document
    ? [
        ...includeCompletions(document.getText(), params.position, includeOptions(document)),
        ...completionAt(document.getText(), params.position, { workspaceTokens: workspaceIndex.tokens() }),
      ]
    : []
})

connection.onRequest(DocumentFormattingRequest.type, (params) => {
  const document = documents.get(params.textDocument.uri)
  if (!document) return []
  const text = document.getText()
  const formatted = carveSettings.formatter === 'migration'
    ? (carveSettings.formatAlignTables ? alignTablesInDocument(carveToCarve(text)) : carveToCarve(text))
    : formatDocument(carveSettings.formatAlignTables ? alignTablesInDocument(text) : text)
  if (formatted === text) return []
  return [
    {
      range: { start: document.positionAt(0), end: document.positionAt(text.length) },
      newText: formatted,
    },
  ]
})

connection.onRequest(DocumentRangeFormattingRequest.type, (params) => {
  const document = documents.get(params.textDocument.uri)
  if (!document) return []
  const text = document.getText()
  if (carveSettings.formatAlignTables) {
    const edits = tableAlignmentEdits(text, params.range.start.line, params.range.end.line)
    if (edits.length > 0) {
      const firstLine = Math.min(params.range.start.line, ...edits.map(edit => edit.startLine))
      const lastLine = Math.max(params.range.end.line, ...edits.map(edit => edit.endLine))
      const lines = text.replace(/\r\n?/g, '\n').split('\n')
      return [{
        range: { start: { line: firstLine, character: 0 }, end: { line: lastLine, character: (lines[lastLine] ?? '').length } },
        newText: formatRange(alignTablesInDocument(text), firstLine, lastLine),
      }]
    }
  }
  const newText = formatRange(text, params.range.start.line, params.range.end.line)
  const lines = text.replace(/\r\n?/g, '\n').split('\n')
  return [{
    range: {
      start: { line: params.range.start.line, character: 0 },
      end: { line: params.range.end.line, character: (lines[params.range.end.line] ?? '').length },
    },
    newText,
  }]
})

connection.onRequest(DocumentOnTypeFormattingRequest.type, (params) => {
  if (params.ch !== '\n') return []
  const document = documents.get(params.textDocument.uri)
  if (!document) return []
  const list = listContinuationEdits(document.getText(), params.position)
  if (list) return list
  const continuation = continuationEdits(document.getText(), params.position)
  const aligned = carveSettings.formatAlignTables
    ? tableAlignmentEdits(document.getText(), Math.max(0, params.position.line - 1), Math.max(0, params.position.line - 1))
      .map(edit => edit.textEdit)
      .filter(edit => !continuation.some(next =>
        next.range.start.line >= edit.range.start.line && next.range.start.line <= edit.range.end.line))
    : []
  return [...aligned, ...continuation]
})

connection.onRequest(FoldingRangeRequest.type, (params) => {
  const document = documents.get(params.textDocument.uri)
  return document ? foldingRanges(document.getText()) : []
})

connection.onRequest(PrepareRenameRequest.type, (params) => {
  const document = documents.get(params.textDocument.uri)
  if (!document) return null
  const local = prepareRename(document.getText(), params.position)
  if (local) return local
  const token = workspaceIndex.tokenAt(document.uri, params.position)
  return token ? { range: token.range, placeholder: token.key } : null
})

connection.onRequest(RenameRequest.type, (params) => {
  const document = documents.get(params.textDocument.uri)
  if (!document) return null
  return workspaceIndex.rename(document.uri, params.position, params.newName) ??
    renameEdits(params.textDocument.uri, document.getText(), params.position, params.newName)
})

connection.onRequest(CodeLensRequest.type, (params) => {
  const document = documents.get(params.textDocument.uri)
  return document ? codeLenses(document.getText()) : []
})

connection.onRequest(DefinitionRequest.type, (params) => {
  const document = documents.get(params.textDocument.uri)
  if (!document) return null
  const local = definitionAt(
        params.textDocument.uri,
        document.getText(),
        params.position,
        includeOptions(document),
      )
  if (local) return local
  const token = workspaceIndex.tokenAt(document.uri, params.position)
  const target = token ? workspaceIndex.definitions(token.kind, token.key, document.uri)[0] : undefined
  return target ? { uri: target.uri, range: target.range } : null
})

connection.onRequest(ReferencesRequest.type, (params) => {
  const document = documents.get(params.textDocument.uri)
  if (!document) return null
  const token = workspaceIndex.tokenAt(document.uri, params.position)
  if (token) return workspaceIndex.references(token.kind, token.key, params.context.includeDeclaration, document.uri)
  return referencesAt(params.textDocument.uri, document.getText(), params.position, params.context)
})

connection.languages.semanticTokens.on((params) => {
  const document = documents.get(params.textDocument.uri)
  if (!document) return { data: [] }
  const builder = new SemanticTokensBuilder()
  semanticBuilders.set(document.uri, builder)
  return buildSemanticTokens(document.getText(), builder, { extensions: carveSettings.extensions })
})

connection.languages.semanticTokens.onDelta((params) => {
  const document = documents.get(params.textDocument.uri)
  if (!document) return { data: [] }
  const builder = semanticBuilders.get(document.uri) ?? new SemanticTokensBuilder()
  semanticBuilders.set(document.uri, builder)
  return updateSemanticTokens(document.getText(), builder, params.previousResultId, { extensions: carveSettings.extensions })
})

connection.languages.semanticTokens.onRange((params) => {
  const document = documents.get(params.textDocument.uri)
  return document
    ? buildSemanticTokensRange(document.getText(), params.range.start.line, params.range.end.line, { extensions: carveSettings.extensions })
    : { data: [] }
})

function validate(document: TextDocument) {
  const includes = includeOptions(document)
  const analysis = analysisFor(document, includes)
  const changed = dependencyIndex.update(
    document.uri,
    analysis.dependencies.flatMap((dependency) =>
      dependency.watch === undefined ? [] : [dependency.watch],
    ),
  )
  if (changed) refreshWatchers()
  connection.sendDiagnostics({
    uri: document.uri,
    diagnostics: analysis.diagnostics,
  })
}

function analysisFor(document: TextDocument, includes = includeOptions(document)): Analysis {
  return analysisCache.getOrCreate(document.uri, document.version, () => analyzeCarve(document.getText(), {
    uri: document.uri,
    lint: {
      platforms: carveSettings.platforms,
      extensions: carveSettings.extensions,
      severities: carveSettings.severities,
    },
    ...(includes ? { includes } : {}),
    includedParseCache: includeParseCache,
  }))
}

function includeGateInput(document: TextDocument): IncludeGateInput {
  return {
    uri: document.uri,
    settings: includeSettings,
    workspaceTrusted,
    workspaceRoots,
    cache: includeCache,
  }
}

function includeOptions(document: TextDocument) {
  return withOpenDocuments(includeOptionsFor(includeGateInput(document)))
}

function previewIncludeOptions(document: TextDocument) {
  return withOpenDocuments(previewIncludeOptionsFor(includeGateInput(document)))
}

function withOpenDocuments(options: ReturnType<typeof includeOptionsFor>) {
  if (!options) return undefined
  const diskResolver = options.resolver
  if (!diskResolver) return options
  const openByPath = new Map<string, TextDocument>()
  for (const document of documents.all()) {
    const target = fsPath(document.uri)
    if (!target) continue
    try { openByPath.set(realpathSync(target), document) } catch { /* no disk identity */ }
  }
  options.resolver = (includePath, context) => {
    const result = diskResolver(includePath, context)
    if (!result.ok) return result
    const open = openByPath.get(result.id)
    if (!open) return result
    const source = open.getText()
    return { ...result, source, bytes: Buffer.byteLength(source), version: `open:${open.version}` }
  }
  return options
}

function invalidateIncludedParse(uri: string): void {
  const target = fsPath(uri)
  if (!target) return
  try { includeParseCache.invalidate(realpathSync(target)) } catch { /* no disk identity */ }
}

function revalidateIncludingDocuments(uri: string): void {
  const target = fsPath(uri)
  if (!target) return
  let canonical: string
  try { canonical = realpathSync(target) } catch { return }
  for (const parentUri of dependencyIndex.documentsFor(canonical)) {
    if (parentUri === uri) continue
    const parent = documents.get(parentUri)
    if (!parent) continue
    analysisCache.remove(parentUri)
    diagnostics.schedule(parentUri, parent.version)
  }
}

function refreshWatchers(): void {
  const paths = dependencyIndex.watchedPaths()
  watcherRefresh = watcherRefresh.then(async () => {
    watcherRegistration?.dispose()
    watcherRegistration = undefined
    if (paths.length === 0) return
    watcherRegistration = await connection.client.register(DidChangeWatchedFilesNotification.type, {
      watchers: paths.map(watcherFor),
    })
  }).catch((error: unknown) => {
    connection.console.warn(`Could not register include watchers: ${String(error)}`)
  })
}

function flattenSymbols(symbols: DocumentSymbol[], uri: string): SymbolInformation[] {
  const result: SymbolInformation[] = []
  const visit = (items: DocumentSymbol[], containerName?: string): void => {
    for (const symbol of items) {
      result.push({
        name: symbol.name,
        kind: symbol.kind,
        location: { uri, range: symbol.range },
        ...(containerName === undefined ? {} : { containerName }),
      })
      visit(symbol.children ?? [], symbol.name)
    }
  }
  visit(symbols)
  return result
}

documents.listen(connection)
connection.listen()
