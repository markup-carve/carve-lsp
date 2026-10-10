/*
 * Conservative Carve formatter.
 *
 * Carve source does not have a canonical serializer, and whitespace that looks
 * cosmetic can be structural: a second blank line detaches captions, trailing
 * blank lines can belong to an unclosed fence, and trailing spaces are content
 * in line blocks. Preserve every source byte except for adding a missing final
 * line ending, which is render-equivalent and keeps the formatter idempotent.
 */

import { parse, type Document, type Position } from '@markup-carve/carve'

export function formatDocument(source: string): string {
  if (source === '' || source.endsWith('\n')) return source
  return source + (source.includes('\r\n') ? '\r\n' : '\n')
}

export function formatRange(source: string, startLine: number, endLine: number): string {
  const eol = source.includes('\r\n') ? '\r\n' : '\n'
  return source.split(/\r?\n/).slice(startLine, endLine + 1).join(eol)
}

/** Prefix inserted after Enter for container-shaped lines. */
export function continuationPrefix(source: string, line: number): string {
  const previous = source.split(/\r?\n/)[line - 1] ?? ''
  const container = /^(\s*)(:{3,}) [^\s].*$/.exec(previous)
  if (container) return `\n${container[1]}${container[2]}`
  const quote = /^(\s*(?:> )+)/.exec(previous)
  if (quote) return quote[1]!
  const table = /^(\s*)\|/.exec(previous)
  if (table) return `${table[1]}| `
  // A description marker is a colon, a run of SPACES, then something. PART 2
  // (MARKER REQUIRES CONTENT, carve#1830, corpus 439) makes a colon followed by
  // only whitespace a paragraph, so there is no description to continue - and a
  // tab separator is not a marker either. The separator run sets the body's
  // content column (corpus 424), so the continuation is as wide as it is rather
  // than always two.
  //
  // The lookahead asks whether the REST OF THE LINE is blank, not whether the
  // next character is non-blank, on purpose: `: ` followed by a tab is the case
  // carve#1836 rules and every engine is still wrong about, so this decides it
  // neither way and keeps the answer it already gave.
  const definition = /^([ \t]*)(: +)(?![ \t]*$)/.exec(previous)
  if (definition) return definition[1]! + ' '.repeat(definition[2]!.length)
  return ''
}

export interface ContinuationEdit {
  range: { start: { line: number; character: number }; end: { line: number; character: number } }
  newText: string
}

const BULLET = /^([ \t]*)([-*])([ \t]+)/
const BARE_DOT = /^([ \t]*)(\.)([ \t]+)/
const ORDERED = /^([ \t]*)([0-9]+|[A-Za-z]+)([.)])([ \t]+)/
const TASK = /^\[[ xX-]\]([ \t]+|$)/
// A marker and its separator alone on a line, as the continuation writes it. A
// lone `-` with no separator is left alone: it may be prose. Only bullets carry
// a task box; after an ordered marker `[ ]` is text.
const BARE_MARKER = /^[ \t]*(?:[-*][ \t]+(?:\[ \][ \t]+)?|(?:\.|(?:[0-9]+|[A-Za-z]|[ivxlcdmIVXLCDM]+)[.)])[ \t]+)$/

interface ItemLine { olType?: string; delim?: string }

/**
 * Enter after a list item writes the next marker; Enter after a content-less
 * marker removes it, which ends the list. Returns null when the line before
 * the cursor is not a list line, so other continuations can run.
 */
export function listContinuationEdits(source: string, position: { line: number; character: number }): ContinuationEdit[] | null {
  const lines = source.split(/\r?\n/)
  const current = lines[position.line] ?? ''
  if (current.trim() !== '' || position.line === 0) return null
  const prevLine = position.line - 1
  const previous = lines[prevLine] ?? ''
  const structure = listStructure(source)
  if (!structure || structure.code.has(prevLine)) return null

  if (BARE_MARKER.test(previous)) {
    if (!structure.covered.has(prevLine)) return null
    return [{ range: { start: { line: prevLine, character: 0 }, end: { line: prevLine, character: previous.length } }, newText: '' }]
  }

  const item = structure.starts.get(prevLine)
  if (!item) return null
  const marker = nextMarker(previous, item)
  if (marker === null) return null
  return [{ range: { start: { line: position.line, character: 0 }, end: position }, newText: marker }]
}

function nextMarker(line: string, item: ItemLine): string | null {
  const bullet = BULLET.exec(line)
  if (bullet) return bullet[1]! + bullet[2]! + bullet[3]! + taskBox(line.slice(bullet[0].length))
  const dot = BARE_DOT.exec(line)
  if (dot) return dot[1]! + dot[2]! + dot[3]!
  const ordered = ORDERED.exec(line)
  if (!ordered || ordered[3] !== item.delim) return null
  const [, indent, ordinal, delim, separator] = ordered as unknown as [string, string, string, string, string]
  const next = increment(ordinal, item.olType)
  if (next === null) return null
  // Keep the content column when the marker changes width (9. -> 10., iii. -> iv.),
  // but never drop below one space. A tab separator is copied as written.
  const width = ordinal.length + delim.length + separator.length
  const gap = /\t/.test(separator) ? separator : ' '.repeat(Math.max(1, width - next.length - delim.length))
  return indent + next + delim + gap
}

function taskBox(body: string): string {
  const task = TASK.exec(body)
  return task ? `[ ]${task[1] || ' '}` : ''
}

function increment(ordinal: string, olType: string | undefined): string | null {
  if (/^[0-9]+$/.test(ordinal)) return (BigInt(ordinal) + 1n).toString().padStart(ordinal.length, '0')
  if (olType === 'i' || olType === 'I') {
    const value = fromRoman(ordinal.toLowerCase())
    if (value === null) return null
    const roman = toRoman(value + 1)
    return olType === 'I' ? roman.toUpperCase() : roman
  }
  if ((olType === 'a' || olType === 'A') && ordinal.length === 1) {
    if (ordinal === 'z' || ordinal === 'Z') return null
    return String.fromCharCode(ordinal.charCodeAt(0) + 1)
  }
  return null
}

const ROMAN: Array<[number, string]> = [
  [1000, 'm'], [900, 'cm'], [500, 'd'], [400, 'cd'], [100, 'c'], [90, 'xc'],
  [50, 'l'], [40, 'xl'], [10, 'x'], [9, 'ix'], [5, 'v'], [4, 'iv'], [1, 'i'],
]

function toRoman(value: number): string {
  let out = ''
  for (const [amount, digits] of ROMAN) while (value >= amount) { out += digits; value -= amount }
  return out
}

function fromRoman(text: string): number | null {
  let value = 0
  let rest = text
  for (const [amount, digits] of ROMAN) while (rest.startsWith(digits)) { value += amount; rest = rest.slice(digits.length) }
  return rest === '' && value > 0 ? value : null
}

interface ListStructure {
  /** Zero-based line -> the outermost list item whose marker opens it. */
  starts: Map<number, ItemLine>
  /** Zero-based lines of paragraphs held directly by a list item. */
  covered: Set<number>
  /** Zero-based lines of code and raw blocks, fences included. */
  code: Set<number>
}

function listStructure(source: string): ListStructure | null {
  let doc: Document
  try {
    doc = parse(source, { positions: true })
  } catch {
    return null
  }
  const structure: ListStructure = { starts: new Map(), covered: new Set(), code: new Set() }
  const visit = (value: unknown, list?: ItemLine, inItem = false): void => {
    if (Array.isArray(value)) {
      for (const entry of value) visit(entry, list, inItem)
      return
    }
    if (value === null || typeof value !== 'object') return
    const node = value as { type?: unknown; pos?: Position; olType?: string; delim?: string }
    const pos = node.pos
    if ((node.type === 'code_block' || node.type === 'raw_block') && pos?.startLine !== undefined && pos.endLine !== undefined) {
      for (let line = pos.startLine - 1; line < pos.endLine; line++) structure.code.add(line)
      return
    }
    // A bare marker after an item is lazy paragraph text of that item; one inside a
    // nested container belongs to the container and is left alone.
    if (node.type === 'paragraph' && inItem && pos?.startLine !== undefined && pos.endLine !== undefined) {
      for (let line = pos.startLine - 1; line < pos.endLine; line++) structure.covered.add(line)
    }
    if (node.type === 'list') list = { olType: node.olType, delim: node.delim }
    const item = node.type === 'list_item'
    if (item && pos?.startLine !== undefined && !structure.starts.has(pos.startLine - 1)) {
      structure.starts.set(pos.startLine - 1, { ...list })
    }
    for (const key of Object.keys(node)) {
      if (key === 'pos') continue
      visit((node as Record<string, unknown>)[key], list, item && key === 'children')
    }
  }
  visit(doc.children)
  return structure
}
