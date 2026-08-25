import { DiagnosticSeverity, DocumentHighlightKind, InlayHintKind, type Diagnostic, type DocumentHighlight, type Hover, type InlayHint, type Position, type Range } from 'vscode-languageserver/node.js'
import { parse } from '@markup-carve/carve'

interface UnclosedContainer { kind: string; line: number; column: number; startOffset: number; endOffset: number; fenceWidth: number }

export interface FenceSite { kind: string; width: number; range: Range }
export interface FencePair { opener: FenceSite; closer: FenceSite }

export function colonFenceStructure(source: string): { pairs: FencePair[]; diagnostics: Diagnostic[] } {
  const lines = source.replace(/\r\n?/g, '\n').split('\n')
  const unclosed: UnclosedContainer[] = []
  const document = parse(source, { positions: true, onUnclosedContainer: (site) => unclosed.push(site) })
  const key = (line: number, column: number, width: number) => `${line}:${column}:${width}`
  const unclosedKeys = new Set(unclosed.map((site) => key(site.line, site.column, site.fenceWidth)))
  const pairs: FencePair[] = []
  const diagnostics: Diagnostic[] = []
  const walk = (value: unknown, parent: FenceSite | null): void => {
    if (Array.isArray(value)) { for (const child of value) walk(child, parent); return }
    if (!value || typeof value !== 'object') return
    const node = value as Record<string, unknown>
    const site = astFenceSite(node, lines)
    const nextParent = site ?? parent
    if (site) {
      const siteKey = key(site.range.start.line + 1, site.range.start.character + 1, site.width)
      const run = lineRun(lines[site.range.start.line] ?? '', site.range.start.character)
      if (unclosedKeys.has(siteKey) && run?.bare && parent && site.width !== parent.width) {
        diagnostics.push({ severity: DiagnosticSeverity.Warning, source: 'carve', code: 'colon-fence-length-mismatch', range: site.range,
          message: `Bare ${site.width}-colon fence does not close the innermost ${parent.width}-colon ${parent.kind} opened at ${parent.range.start.line + 1}:${parent.range.start.character + 1}; it currently opens a nested container.`,
          data: { authoredWidth: site.width, expectedWidth: parent.width, openerLine: parent.range.start.line + 1, openerColumn: parent.range.start.character + 1, outcome: 'nested container' } })
      } else if (!unclosedKeys.has(siteKey)) {
        const pos = node.pos as { endLine?: number; endColumn?: number } | undefined
        const closeLine = (pos?.endLine ?? 1) - 1
        const closeCharacter = (pos?.endColumn ?? 1) - 1 - site.width
        const close = lineRun(lines[closeLine] ?? '', closeCharacter)
        if (close?.bare && close.width === site.width) pairs.push({ opener: site, closer: fenceSite(closeLine, closeCharacter, site.width, site.kind) })
      }
    }
    for (const [name, child] of Object.entries(node)) if (name !== 'pos' && name !== 'attrs') walk(child, nextParent)
  }
  walk(document.children, null)
  return { pairs, diagnostics }
}

export function colonFenceHighlights(source: string, position: Position): DocumentHighlight[] {
  const pair = colonFenceStructure(source).pairs.find(({ opener, closer }) => contains(opener.range, position) || contains(closer.range, position))
  return pair ? [
    { range: pair.opener.range, kind: DocumentHighlightKind.Write },
    { range: pair.closer.range, kind: DocumentHighlightKind.Read },
  ] : []
}

export function colonFenceHover(source: string, position: Position): Hover | null {
  const pair = colonFenceStructure(source).pairs.find(({ closer }) => contains(closer.range, position))
  if (!pair) return null
  return {
    contents: { kind: 'markdown', value: `**${pair.opener.kind} closer**\n\nEnds the ${pair.opener.width}-colon container from ${pair.opener.range.start.line + 1}:${pair.opener.range.start.character + 1} through ${pair.closer.range.end.line + 1}:${pair.closer.range.end.character + 1}.` },
    range: pair.closer.range,
  }
}

export function colonFenceInlayHints(source: string, range: Range): InlayHint[] {
  return colonFenceStructure(source).pairs
    .filter(({ closer }) => closer.range.start.line >= range.start.line && closer.range.start.line <= range.end.line)
    .map(({ opener, closer }) => ({ position: closer.range.end, label: ` closes ${opener.kind} from line ${opener.range.start.line + 1}`, kind: InlayHintKind.Type, paddingLeft: true }))
}

export function linkedColonFenceRanges(source: string, position: Position): { ranges: Range[]; wordPattern: string } | null {
  const pair = colonFenceStructure(source).pairs.find(({ opener, closer }) => contains(opener.range, position) || contains(closer.range, position))
  return pair ? { ranges: [pair.opener.range, pair.closer.range], wordPattern: ':{3,}' } : null
}

function fenceSite(line: number, character: number, width: number, kind: string): FenceSite {
  return { kind, width, range: { start: { line, character }, end: { line, character: character + width } } }
}
function astFenceSite(node: Record<string, unknown>, lines: string[]): FenceSite | null {
  const kind = node.type === 'div' ? 'div' : node.type === 'admonition' ? `${String(node.kind ?? '')} admonition`.trim()
    : node.type === 'line_block' ? 'line block' : node.type === 'hard_break_block' ? 'hard-break block' : null
  const pos = node.pos as { startLine?: number; startColumn?: number } | undefined
  if (!kind || !pos?.startLine || !pos.startColumn) return null
  const run = lineRun(lines[pos.startLine - 1] ?? '', pos.startColumn - 1)
  return run ? fenceSite(pos.startLine - 1, pos.startColumn - 1, run.width, kind) : null
}
function lineRun(line: string, at: number): { width: number; bare: boolean } | null {
  const match = /^(:{3,})(.*)$/.exec(line.slice(at))
  return match ? { width: match[1]!.length, bare: /^[ \t]*$/.test(match[2]!) } : null
}
function contains(range: Range, p: Position): boolean {
  return p.line === range.start.line && p.character >= range.start.character && p.character <= range.end.character
}
