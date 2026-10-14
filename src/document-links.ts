import { type DocumentLink } from 'vscode-languageserver-types'
import { walkNodes } from './ast-walk.js'
import { referenceModel, type ReferenceModel } from './reference-sites.js'
import { astOffsetToIndex } from './position.js'

/** Clickable destinations the parser read: inline links and images, autolinks, reference definitions. */
export function documentLinks(uri: string, source: string): DocumentLink[] {
  const model = referenceModel(source)
  const links: DocumentLink[] = []
  if (!model.doc) return links
  const { text } = model
  walkNodes(model.doc, (node) => {
    const pos = node.pos
    if (pos?.startOffset === undefined || pos.endOffset === undefined) return
    const start = astOffsetToIndex(text, pos.startOffset)
    const end = astOffsetToIndex(text, pos.endOffset)
    if (node.type === 'autolink' && typeof node.href === 'string') {
      add(links, model, uri, node.href, start + 1, end - 1)
    } else if ((node.type === 'link' || node.type === 'image') && node.rawRef === undefined) {
      const destination = node.type === 'link' ? node.href : node.src
      if (typeof destination === 'string' && destination !== '') locate(links, model, uri, destination, start, end)
    } else if (node.type === 'link_reference_definition' && typeof node.href === 'string' && node.href !== '') {
      locate(links, model, uri, node.href, start, end)
    }
  })
  return links.sort((a, b) => a.range.start.line - b.range.start.line || a.range.start.character - b.range.start.character)
}

/** Range the destination as written; fall back to the whole construct when it was escaped or encoded. */
function locate(links: DocumentLink[], model: ReferenceModel, uri: string, destination: string, start: number, end: number): void {
  const at = model.text.lastIndexOf(destination, end - destination.length)
  if (at >= start) add(links, model, uri, destination, at, at + destination.length)
  else add(links, model, uri, destination, start, end)
}

function add(links: DocumentLink[], model: ReferenceModel, uri: string, destination: string, start: number, end: number): void {
  let target: string
  try {
    target = new URL(destination, uri).toString()
  } catch {
    return
  }
  links.push({
    target,
    tooltip: `Open ${destination}`,
    range: { start: model.positionAt(start), end: model.positionAt(end) },
  })
}
