import { readdirSync, readFileSync, realpathSync } from 'node:fs'
import path from 'node:path'
import { CompletionItemKind, type CompletionItem, type Position } from 'vscode-languageserver/node.js'
import type { IncludeOptions } from './includes.js'
import { scanDocument } from './workspace-index.js'

export function includeCompletions(source: string, position: Position, options?: IncludeOptions): CompletionItem[] {
  if (!options?.sourcePath || !options.includeRoot) return []
  const line = source.replace(/\r\n?/g, '\n').split('\n')[position.line] ?? ''
  const prefix = line.slice(0, position.character)
  const match = /\{\{\s*([^\s}@]*)$/.exec(prefix)
  if (!match) return []
  const authored = match[1]!
  const [filePart, fragment] = authored.split('#', 2)
  const root = realpathSafe(options.includeRoot)
  if (!root) return []
  const base = path.resolve(path.dirname(options.sourcePath), path.dirname(filePart || '.'))
  const contained = realpathSafe(base)
  if (!contained || !isInside(root, contained)) return []
  const replaceStart = position.character - (fragment === undefined ? path.basename(filePart) : fragment).length
  if (fragment !== undefined) {
    const target = realpathSafe(path.resolve(path.dirname(options.sourcePath), filePart))
    if (!target || !isInside(root, target)) return []
    let targetSource: string
    try { targetSource = readFileSync(target, 'utf8') } catch { return [] }
    return scanDocument(target, targetSource)
      .filter((token) => token.kind === 'heading' && token.declaration)
      .map((token) => item(token.key, CompletionItemKind.Reference, position, replaceStart, 'Section in included file'))
  }
  const partial = path.basename(filePart)
  let entries
  try { entries = readdirSync(contained, { withFileTypes: true }) } catch { return [] }
  return entries
    .filter((entry) => entry.name.startsWith(partial) && (entry.isDirectory() || entry.name.endsWith('.crv')))
    .map((entry) => item(entry.name + (entry.isDirectory() ? '/' : ''), entry.isDirectory() ? CompletionItemKind.Folder : CompletionItemKind.File,
      position, replaceStart, 'Contained include path'))
}

function item(label: string, kind: CompletionItemKind, position: Position, start: number, detail: string): CompletionItem {
  return { label, kind, detail, textEdit: {
    range: { start: { line: position.line, character: start }, end: position },
    newText: label,
  } }
}

function realpathSafe(value: string): string | null {
  try { return realpathSync(value) } catch { return null }
}

function isInside(root: string, target: string): boolean {
  const relative = path.relative(root, target)
  return relative === '' || (!path.isAbsolute(relative) && !relative.split(path.sep).includes('..'))
}
