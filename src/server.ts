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
import { analyzeCarve } from './analyze.js'
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

connection.onInitialize(() => ({
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
}))

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
  const analysis = analyzeCarve(document.getText())
  connection.sendDiagnostics({
    uri: document.uri,
    diagnostics: analysis.diagnostics,
  })
}

documents.listen(connection)
connection.listen()
