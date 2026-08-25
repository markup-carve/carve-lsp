#!/usr/bin/env node
import {
  CodeActionRequest,
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
} from 'vscode-languageserver/node.js'
import { TextDocument } from 'vscode-languageserver-textdocument'
import { carveToCarve } from '@markup-carve/carve'
import { analyzeCarve, type Analysis } from './analyze.js'
import {
  DEFAULT_INCLUDE_SETTINGS,
  fsPath,
  includeOptionsFor,
  readIncludeSettings,
  readWorkspaceTrusted,
  type IncludeSettings,
} from './include-settings.js'
import { definitionAt } from './definition.js'
import { referencesAt } from './references.js'
import { codeLenses } from './codelens.js'
import { completionAt } from './completion.js'
import { foldingRanges } from './folding.js'
import { continuationPrefix, formatDocument, formatRange } from './format.js'
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
import { selectionRanges } from './selection.js'
import { WorkspaceIndex } from './workspace-index.js'
import { backlinks, generatedNavigation, rebuildImpact, workspaceGraph } from './workspace-graph.js'
import { indexWorkspace } from './workspace-loader.js'
import { readFileSync, statSync } from 'node:fs'
import { VersionedCache } from './versioned-cache.js'
import { includeCompletions } from './include-completion.js'
import { DEFAULT_CARVE_SETTINGS, readCarveSettings, readProjectSettings, type CarveSettings } from './settings.js'
import { colonFenceInlayHints, linkedColonFenceRanges } from './colon-fences.js'

const connection = createConnection(ProposedFeatures.all)
const documents = new TextDocuments(TextDocument)

let includeSettings: IncludeSettings = DEFAULT_INCLUDE_SETTINGS
let carveSettings: CarveSettings = DEFAULT_CARVE_SETTINGS
let workspaceTrusted = false
let workspaceRoots: string[] = []
let clientOwnsCarveSettings = false
const includeCache = new IncludeSourceCache()
const includeParseCache = new IncludeParseCache()
const dependencyIndex = new DependencyIndex()
const workspaceIndex = new WorkspaceIndex()
const semanticBuilders = new Map<string, SemanticTokensBuilder>()
const analysisCache = new VersionedCache<Analysis>()
let watcherRegistration: Disposable | undefined
let watcherRefresh = Promise.resolve()

connection.onInitialize((params) => {
  includeSettings = readIncludeSettings(params.initializationOptions)
  workspaceTrusted = readWorkspaceTrusted(params.initializationOptions)
  // Every folder, not just the first: a multi-root session roots each document
  // at the folder it actually lives in.
  const folders = (params.workspaceFolders ?? []).map((folder) => fsPath(folder.uri))
  const legacyRoot = params.rootUri != null ? fsPath(params.rootUri) : undefined
  workspaceRoots = [...folders, legacyRoot].filter((root): root is string => root !== undefined)
  clientOwnsCarveSettings = Boolean((params.initializationOptions as { carve?: unknown } | undefined)?.carve)
  carveSettings = clientOwnsCarveSettings
    ? readCarveSettings(params.initializationOptions)
    : readProjectSettings(workspaceRoots) ?? DEFAULT_CARVE_SETTINGS

  return {
    capabilities: {
      textDocumentSync: TextDocumentSyncKind.Incremental,
      documentSymbolProvider: true,
      workspaceSymbolProvider: true,
      hoverProvider: true,
      codeActionProvider: true,
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

connection.onInitialized(() => {
  void connection.client.register(DidChangeConfigurationNotification.type, undefined)
  const loaded = indexWorkspace(workspaceIndex, workspaceRoots)
  if (loaded.truncated) connection.console.warn(`Carve workspace index stopped at ${loaded.files} files / ${loaded.bytes} bytes.`)
  void connection.client.register(DidChangeWatchedFilesNotification.type, {
    watchers: [{ globPattern: '**/*.crv' }, { globPattern: '**/.carverc.json' }],
  })
})

connection.onDidChangeConfiguration((change) => {
  includeSettings = readIncludeSettings(change.settings)
  const supplied = Boolean((change.settings as { carve?: unknown } | undefined)?.carve)
  if (supplied) clientOwnsCarveSettings = true
  carveSettings = supplied || clientOwnsCarveSettings
    ? readCarveSettings(change.settings)
    : readProjectSettings(workspaceRoots) ?? DEFAULT_CARVE_SETTINGS
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
  diagnostics.flush(event.document.uri, event.document.version)
})
documents.onDidChangeContent((event) => {
  workspaceIndex.update(event.document.uri, event.document.getText(), event.document.version)
  diagnostics.schedule(event.document.uri, event.document.version)
})
documents.onDidClose((event) => {
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
  semanticBuilders.delete(event.document.uri)
  if (dependencyIndex.remove(event.document.uri)) refreshWatchers()
  connection.sendDiagnostics({ uri: event.document.uri, diagnostics: [] })
})

connection.onDidChangeWatchedFiles((params) => {
  const affected = new Set<string>()
  for (const change of params.changes) {
    const target = fsPath(change.uri)
    if (target === undefined) continue
    includeCache.invalidate(target)
    includeParseCache.invalidate(target)
    if (target.endsWith('.carverc.json') && !clientOwnsCarveSettings) {
      carveSettings = readProjectSettings(workspaceRoots) ?? DEFAULT_CARVE_SETTINGS
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
  return document ? [...inlayHints(document.getText(), params.range), ...colonFenceInlayHints(document.getText(), params.range)] : []
})

connection.onRequest(LinkedEditingRangeRequest.type, (params) => {
  const document = documents.get(params.textDocument.uri)
  return document ? linkedColonFenceRanges(document.getText(), params.position) : null
})

connection.onRequest(ExecuteCommandRequest.type, async (params) => {
  const uri = typeof params.arguments?.[0] === 'string' ? params.arguments[0] : undefined
  if (params.command === 'carve.workspaceGraph') return workspaceGraph(workspaceIndex)
  if (params.command === 'carve.backlinks') return uri ? backlinks(workspaceIndex, uri) : []
  if (params.command === 'carve.generatedNavigation') return generatedNavigation(workspaceIndex, uri)
  if (params.command === 'carve.rebuildImpact') return uri ? rebuildImpact(workspaceIndex, uri) : []
  const document = uri ? documents.get(uri) : undefined
  if (!document) return null
  const engine = await import('@markup-carve/carve')
  if (params.command === 'carve.previewHtml') return engine.carveToHtml(document.getText())
  if (params.command === 'carve.showAst') return engine.carveToAstJson(document.getText())
  return null
})

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
      ]
    : []
})

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
  const formatted = carveSettings.formatter === 'migration' ? carveToCarve(text) : formatDocument(text)
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
  const newText = formatRange(document.getText(), params.range.start.line, params.range.end.line)
  const lines = document.getText().replace(/\r\n?/g, '\n').split('\n')
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
  const prefix = continuationPrefix(document.getText(), params.position.line)
  return prefix ? [{ range: { start: params.position, end: params.position }, newText: prefix }] : []
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
  const target = token ? workspaceIndex.definitions(token.kind, token.key)[0] : undefined
  return target ? { uri: target.uri, range: target.range } : null
})

connection.onRequest(ReferencesRequest.type, (params) => {
  const document = documents.get(params.textDocument.uri)
  if (!document) return null
  const token = workspaceIndex.tokenAt(document.uri, params.position)
  if (token) return workspaceIndex.references(token.kind, token.key, params.context.includeDeclaration)
  return referencesAt(params.textDocument.uri, document.getText(), params.position, params.context)
})

connection.languages.semanticTokens.on((params) => {
  const document = documents.get(params.textDocument.uri)
  if (!document) return { data: [] }
  const builder = new SemanticTokensBuilder()
  semanticBuilders.set(document.uri, builder)
  return buildSemanticTokens(document.getText(), builder)
})

connection.languages.semanticTokens.onDelta((params) => {
  const document = documents.get(params.textDocument.uri)
  if (!document) return { data: [] }
  const builder = semanticBuilders.get(document.uri) ?? new SemanticTokensBuilder()
  semanticBuilders.set(document.uri, builder)
  return updateSemanticTokens(document.getText(), builder, params.previousResultId)
})

connection.languages.semanticTokens.onRange((params) => {
  const document = documents.get(params.textDocument.uri)
  return document
    ? buildSemanticTokensRange(document.getText(), params.range.start.line, params.range.end.line)
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

function includeOptions(document: TextDocument) {
  return includeOptionsFor({
    uri: document.uri,
    settings: includeSettings,
    workspaceTrusted,
    workspaceRoots,
    cache: includeCache,
  })
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
