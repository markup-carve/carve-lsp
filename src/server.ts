#!/usr/bin/env node
import {
  CodeActionRequest,
  CodeLensRequest,
  CompletionRequest,
  createConnection,
  DefinitionRequest,
  DocumentFormattingRequest,
  DocumentSymbolRequest,
  FoldingRangeRequest,
  HoverRequest,
  PrepareRenameRequest,
  ProposedFeatures,
  ReferencesRequest,
  DidChangeConfigurationNotification,
  DidChangeWatchedFilesNotification,
  RenameRequest,
  TextDocuments,
  TextDocumentSyncKind,
  type Disposable,
  type DocumentSymbol,
  type SymbolInformation,
} from 'vscode-languageserver/node.js'
import { TextDocument } from 'vscode-languageserver-textdocument'
import { analyzeCarve } from './analyze.js'
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
import { formatDocument } from './format.js'
import { hoverAt } from './hover.js'
import { migrationCodeActions } from './migration-actions.js'
import { prepareRename, renameEdits } from './rename.js'
import { DiagnosticScheduler } from './diagnostic-scheduler.js'
import { IncludeParseCache, IncludeSourceCache } from './include-cache.js'
import { DependencyIndex, watcherFor } from './dependencies.js'

const connection = createConnection(ProposedFeatures.all)
const documents = new TextDocuments(TextDocument)

let includeSettings: IncludeSettings = DEFAULT_INCLUDE_SETTINGS
let workspaceTrusted = false
let workspaceRoots: string[] = []
const includeCache = new IncludeSourceCache()
const includeParseCache = new IncludeParseCache()
const dependencyIndex = new DependencyIndex()
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

  return {
    capabilities: {
      textDocumentSync: TextDocumentSyncKind.Incremental,
      documentSymbolProvider: true,
      hoverProvider: true,
      codeActionProvider: true,
      documentFormattingProvider: true,
      foldingRangeProvider: true,
      definitionProvider: true,
      referencesProvider: true,
      renameProvider: { prepareProvider: true },
      codeLensProvider: { resolveProvider: false },
      completionProvider: {
        triggerCharacters: [':', '#', '^', '['],
      },
      // Semantic tokens are intentionally NOT advertised. Editor colouring is owned by the
      // TextMate grammar (carve-grammars / the intellij-carve bundle); a second semantic-token
      // layer over the same text only duplicated and fought it - clients merged the two and
      // painted partial/incorrect ranges (a `{#top}` id showing as a hashtag, etc.). The
      // builder in ./semantic.ts is kept (and tested) for any consumer that opts in explicitly.
    },
  }
})

connection.onInitialized(() => {
  void connection.client.register(DidChangeConfigurationNotification.type, undefined)
})

connection.onDidChangeConfiguration((change) => {
  includeSettings = readIncludeSettings(change.settings)
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
documents.onDidOpen((event) => diagnostics.flush(event.document.uri, event.document.version))
documents.onDidChangeContent((event) =>
  diagnostics.schedule(event.document.uri, event.document.version),
)
documents.onDidClose((event) => {
  diagnostics.cancel(event.document.uri)
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
    for (const uri of dependencyIndex.documentsFor(target)) affected.add(uri)
  }
  for (const uri of affected) {
    const document = documents.get(uri)
    if (document) validate(document)
  }
})

connection.onRequest(DocumentSymbolRequest.type, (params) => {
  const document = documents.get(params.textDocument.uri)
  if (!document) return []
  const includes = includeOptions(document)
  const analysis = analyzeCarve(document.getText(), {
    ...(includes ? { includes } : {}),
    includedParseCache: includeParseCache,
  })
  return analysis.includedSymbols.length > 0
    ? [...flattenSymbols(analysis.symbols, document.uri), ...analysis.includedSymbols]
    : analysis.symbols
})

connection.onRequest(HoverRequest.type, (params) => {
  const document = documents.get(params.textDocument.uri)
  return document ? hoverAt(document.getText(), params.position) : null
})

connection.onRequest(CodeActionRequest.type, (params) => {
  const document = documents.get(params.textDocument.uri)
  return document
    ? migrationCodeActions(params.textDocument.uri, document.getText(), params.context.diagnostics)
    : []
})

connection.onRequest(CompletionRequest.type, (params) => {
  const document = documents.get(params.textDocument.uri)
  return document ? completionAt(document.getText(), params.position) : []
})

connection.onRequest(DocumentFormattingRequest.type, (params) => {
  const document = documents.get(params.textDocument.uri)
  if (!document) return []
  const text = document.getText()
  const formatted = formatDocument(text)
  if (formatted === text) return []
  return [
    {
      range: { start: document.positionAt(0), end: document.positionAt(text.length) },
      newText: formatted,
    },
  ]
})

connection.onRequest(FoldingRangeRequest.type, (params) => {
  const document = documents.get(params.textDocument.uri)
  return document ? foldingRanges(document.getText()) : []
})

connection.onRequest(PrepareRenameRequest.type, (params) => {
  const document = documents.get(params.textDocument.uri)
  return document ? prepareRename(document.getText(), params.position) : null
})

connection.onRequest(RenameRequest.type, (params) => {
  const document = documents.get(params.textDocument.uri)
  return document ? renameEdits(params.textDocument.uri, document.getText(), params.position, params.newName) : null
})

connection.onRequest(CodeLensRequest.type, (params) => {
  const document = documents.get(params.textDocument.uri)
  return document ? codeLenses(document.getText()) : []
})

connection.onRequest(DefinitionRequest.type, (params) => {
  const document = documents.get(params.textDocument.uri)
  return document
    ? definitionAt(
        params.textDocument.uri,
        document.getText(),
        params.position,
        includeOptions(document),
      )
    : null
})

connection.onRequest(ReferencesRequest.type, (params) => {
  const document = documents.get(params.textDocument.uri)
  return document
    ? referencesAt(params.textDocument.uri, document.getText(), params.position, params.context)
    : null
})

function validate(document: TextDocument) {
  const includes = includeOptions(document)
  const analysis = analyzeCarve(document.getText(), {
    ...(includes ? { includes } : {}),
    includedParseCache: includeParseCache,
  })
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
