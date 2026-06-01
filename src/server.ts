#!/usr/bin/env node
import {
  createConnection,
  DocumentSymbolRequest,
  ProposedFeatures,
  TextDocuments,
  TextDocumentSyncKind,
} from 'vscode-languageserver/node.js'
import { TextDocument } from 'vscode-languageserver-textdocument'
import { analyzeCarve } from './analyze.js'

const connection = createConnection(ProposedFeatures.all)
const documents = new TextDocuments(TextDocument)

connection.onInitialize(() => ({
  capabilities: {
    textDocumentSync: TextDocumentSyncKind.Incremental,
    documentSymbolProvider: true,
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

function validate(document: TextDocument) {
  const analysis = analyzeCarve(document.getText())
  connection.sendDiagnostics({
    uri: document.uri,
    diagnostics: analysis.diagnostics,
  })
}

documents.listen(connection)
connection.listen()
