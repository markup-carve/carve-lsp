import {
  DiagnosticSeverity,
  DocumentSymbol,
  Range,
  SymbolKind,
  type Diagnostic,
} from 'vscode-languageserver/node.js'
import {
  djotMigrationWarnings,
  parse,
  resolve,
  type BlockNode,
  type Document,
  type Heading,
  type InlineNode,
} from '@markup-carve/carve'

export interface Analysis {
  diagnostics: Diagnostic[]
  symbols: DocumentSymbol[]
}

export function analyzeCarve(source: string): Analysis {
  const diagnostics: Diagnostic[] = []
  let doc: Document | null = null

  try {
    doc = resolve(parse(source))
  } catch (error) {
    diagnostics.push({
      severity: DiagnosticSeverity.Error,
      range: rangeAt(source, 0, 1),
      source: 'carve',
      message: error instanceof Error ? error.message : String(error),
    })
  }

  for (const warning of djotMigrationWarnings(source)) {
    diagnostics.push({
      severity: DiagnosticSeverity.Warning,
      range: {
        start: { line: warning.line - 1, character: warning.column - 1 },
        end: { line: warning.line - 1, character: warning.column },
      },
      source: 'carve',
      code: warning.rule,
      message: `${warning.message} Suggestion: ${warning.suggestion}`,
    })
  }

  return {
    diagnostics,
    symbols: doc ? documentSymbols(doc) : [],
  }
}

function documentSymbols(doc: Document): DocumentSymbol[] {
  const stack: Array<{ level: number; symbol: DocumentSymbol }> = []
  const roots: DocumentSymbol[] = []

  for (const heading of walkHeadings(doc.children)) {
    const symbol = headingSymbol(heading)
    while (stack.length && stack[stack.length - 1]!.level >= heading.level) {
      stack.pop()
    }
    const parent = stack[stack.length - 1]
    if (parent) {
      parent.symbol.children ??= []
      parent.symbol.children.push(symbol)
    } else {
      roots.push(symbol)
    }
    stack.push({ level: heading.level, symbol })
  }

  return roots
}

function* walkHeadings(nodes: BlockNode[]): Iterable<Heading> {
  for (const node of nodes) {
    if (node.type === 'heading') yield node
    if ('children' in node && Array.isArray(node.children)) {
      yield* walkHeadings(node.children.filter(isBlockNode))
    }
    if (node.type === 'figure') {
      if ('children' in node.target && Array.isArray(node.target.children)) {
        yield* walkHeadings(node.target.children.filter(isBlockNode))
      }
    }
  }
}

function isBlockNode(node: unknown): node is BlockNode {
  return Boolean(node && typeof node === 'object' && 'type' in node)
}

function headingSymbol(heading: Heading): DocumentSymbol {
  const range = heading.pos
    ? {
        start: { line: heading.pos.startLine - 1, character: 0 },
        end: { line: heading.pos.endLine - 1, character: 200 },
      }
    : Range.create(0, 0, 0, 0)
  return {
    name: plainText(heading.children) || `Heading ${heading.level}`,
    kind: SymbolKind.String,
    range,
    selectionRange: range,
    children: [],
  }
}

function plainText(nodes: InlineNode[]): string {
  let out = ''
  for (const node of nodes) {
    if (node.type === 'text') out += node.value
    else if ('children' in node && Array.isArray(node.children)) {
      out += plainText(node.children as InlineNode[])
    } else if (node.type === 'code') out += node.value
    else if (node.type === 'emoji') out += `:${node.name}:`
    else if (node.type === 'mention') out += `@${node.user}`
    else if (node.type === 'tag') out += `#${node.name}`
  }
  return out.trim()
}

function rangeAt(source: string, index: number, length: number): Range {
  const before = source.slice(0, index)
  const line = before.split('\n').length - 1
  const lastNewline = before.lastIndexOf('\n')
  const character = index - lastNewline - 1
  return Range.create(line, character, line, character + length)
}
