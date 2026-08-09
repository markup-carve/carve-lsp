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
  RenameRequest,
  TextDocuments,
  TextDocumentSyncKind,
} from 'vscode-languageserver/node.js'
import { TextDocument } from 'vscode-languageserver-textdocument'
import { DidChangeConfigurationNotification } from 'vscode-languageserver/node.js'
import { dirname } from 'node:path'
import { fileURLToPath } from 'node:url'
import { analyzeCarve } from './analyze.js'
import { fileSystemResolver } from './include-path.js'
import type { IncludeOptions } from './includes.js'
import { definitionAt } from './definition.js'
import { referencesAt } from './references.js'
import { codeLenses } from './codelens.js'
import { completionAt } from './completion.js'
import { foldingRanges } from './folding.js'
import { formatDocument } from './format.js'
import { hoverAt } from './hover.js'
import { migrationCodeActions } from './migration-actions.js'
import { prepareRename, renameEdits } from './rename.js'

const connection = createConnection(ProposedFeatures.all)
const documents = new TextDocuments(TextDocument)

/**
 * Include settings (PART 9 §19). `enabled` defaults to `auto`, which means ON
 * ONLY for a workspace the client has reported as trusted. A client that says
 * nothing about trust therefore gets includes OFF, which is what "opt-in, off
 * for untrusted input" requires: silence is not consent.
 */
interface IncludeSettings {
  enabled: 'auto' | 'on' | 'off'
  /** Containment root override. Otherwise the workspace root, then the document's directory. */
  includeRoot?: string
  /** Allow absolute include paths, still subject to root containment. */
  allowAbsolute?: boolean
  /** Hosts a remote include may name. Empty means none; this server never fetches. */
  allowedRemoteHosts?: string[]
  maxDepth?: number
  maxBytes?: number
}

const DEFAULT_INCLUDE_SETTINGS: IncludeSettings = { enabled: 'auto' }

let includeSettings: IncludeSettings = DEFAULT_INCLUDE_SETTINGS
let workspaceTrusted = false
let workspaceRoot: string | undefined

function readIncludeSettings(raw: unknown): IncludeSettings {
  const source = (raw as { carve?: { includes?: Record<string, unknown> } } | undefined)?.carve
    ?.includes
  if (!source || typeof source !== 'object') return DEFAULT_INCLUDE_SETTINGS
  const enabled = source['enabled']
  const settings: IncludeSettings = {
    enabled: enabled === 'on' || enabled === 'off' ? enabled : 'auto',
  }
  if (typeof source['includeRoot'] === 'string') settings.includeRoot = source['includeRoot']
  if (typeof source['allowAbsolute'] === 'boolean') settings.allowAbsolute = source['allowAbsolute']
  if (Array.isArray(source['allowedRemoteHosts'])) {
    settings.allowedRemoteHosts = source['allowedRemoteHosts'].filter(
      (host): host is string => typeof host === 'string',
    )
  }
  if (typeof source['maxDepth'] === 'number') settings.maxDepth = source['maxDepth']
  if (typeof source['maxBytes'] === 'number') settings.maxBytes = source['maxBytes']
  return settings
}

function fsPath(uri: string): string | undefined {
  if (!uri.startsWith('file:')) return undefined
  try {
    return fileURLToPath(uri)
  } catch {
    return undefined
  }
}

/**
 * Build the include options for one document, or undefined to leave the
 * directive literal.
 *
 * The containment root is the explicit override, else the workspace root, else
 * the document's own directory for a file opened outside any workspace. It is
 * NEVER the process working directory: a language server is commonly spawned
 * from the user's home or from `/`, and rooting there would make containment
 * meaningless.
 */
function includeOptionsFor(uri: string): IncludeOptions | undefined {
  if (includeSettings.enabled === 'off') return undefined
  if (includeSettings.enabled === 'auto' && !workspaceTrusted) return undefined

  const documentPath = fsPath(uri)
  if (documentPath === undefined) return undefined

  const root = includeSettings.includeRoot ?? workspaceRoot ?? dirname(documentPath)
  let resolver
  try {
    resolver = fileSystemResolver(root, {
      allowAbsolute: includeSettings.allowAbsolute ?? false,
      allowedRemoteHosts: includeSettings.allowedRemoteHosts ?? [],
    })
  } catch {
    // A root that is not a real directory yields no capability at all, rather
    // than a resolver that silently falls back to somewhere wider.
    return undefined
  }

  const options: IncludeOptions = { resolver, sourcePath: documentPath, includeRoot: root }
  if (includeSettings.maxDepth !== undefined) options.maxDepth = includeSettings.maxDepth
  if (includeSettings.maxBytes !== undefined) options.maxBytes = includeSettings.maxBytes
  return options
}

connection.onInitialize((params) => {
  includeSettings = readIncludeSettings(params.initializationOptions)
  // Client-reported workspace trust. Absent means untrusted.
  workspaceTrusted =
    (params.initializationOptions as { workspaceTrusted?: unknown } | undefined)
      ?.workspaceTrusted === true
  workspaceRoot =
    (params.workspaceFolders?.[0]?.uri !== undefined
      ? fsPath(params.workspaceFolders[0].uri)
      : undefined) ?? (params.rootUri !== null && params.rootUri !== undefined ? fsPath(params.rootUri) : undefined)

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
  for (const document of documents.all()) validate(document)
})

documents.onDidOpen((event) => validate(event.document))
documents.onDidChangeContent((event) => validate(event.document))
documents.onDidClose((event) => {
  connection.sendDiagnostics({ uri: event.document.uri, diagnostics: [] })
})

connection.onRequest(DocumentSymbolRequest.type, (params) => {
  const document = documents.get(params.textDocument.uri)
  return document ? analyzeCarve(document.getText()).symbols : []
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
  return document ? definitionAt(params.textDocument.uri, document.getText(), params.position) : null
})

connection.onRequest(ReferencesRequest.type, (params) => {
  const document = documents.get(params.textDocument.uri)
  return document
    ? referencesAt(params.textDocument.uri, document.getText(), params.position, params.context)
    : null
})

function validate(document: TextDocument) {
  const includes = includeOptionsFor(document.uri)
  const analysis = analyzeCarve(document.getText(), includes ? { includes } : {})
  connection.sendDiagnostics({
    uri: document.uri,
    diagnostics: analysis.diagnostics,
  })
}

documents.listen(connection)
connection.listen()
