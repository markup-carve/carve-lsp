#!/usr/bin/env node
import {
  CodeActionRequest,
  CompletionRequest,
  createConnection,
  DocumentFormattingRequest,
  DocumentSymbolRequest,
  HoverRequest,
  ProposedFeatures,
  SemanticTokensRequest,
  TextDocuments,
  TextDocumentSyncKind,
} from 'vscode-languageserver/node.js'
import { TextDocument } from 'vscode-languageserver-textdocument'
import { analyzeCarve } from './analyze.js'
import { completionAt } from './completion.js'
import { formatDocument } from './format.js'
import { hoverAt } from './hover.js'
import { migrationCodeActions } from './migration-actions.js'
import { buildSemanticTokens, semanticTokenModifiers, semanticTokenTypes } from './semantic.js'

const connection = createConnection(ProposedFeatures.all)
const documents = new TextDocuments(TextDocument)

connection.onInitialize(() => ({
  capabilities: {
    textDocumentSync: TextDocumentSyncKind.Incremental,
    documentSymbolProvider: true,
    hoverProvider: true,
    codeActionProvider: true,
    documentFormattingProvider: true,
    completionProvider: {
      triggerCharacters: [':', '#', '^', '['],
    },
    semanticTokensProvider: {
      legend: {
        tokenTypes: [...semanticTokenTypes],
        tokenModifiers: [...semanticTokenModifiers],
      },
      full: true,
    },
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

connection.onRequest(SemanticTokensRequest.type, (params) => {
  const document = documents.get(params.textDocument.uri)
  return document ? buildSemanticTokens(document.getText()) : { data: [] }
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

function validate(document: TextDocument) {
  const analysis = analyzeCarve(document.getText())
  connection.sendDiagnostics({
    uri: document.uri,
    diagnostics: analysis.diagnostics,
  })
}

documents.listen(connection)
connection.listen()
