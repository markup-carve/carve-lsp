import { type DocumentLink } from 'vscode-languageserver/node.js'

/** Clickable destinations whose target is explicit in source. */
export function documentLinks(uri: string, source: string): DocumentLink[] {
  const links: DocumentLink[] = []
  const lines = source.replace(/\r\n?/g, '\n').split('\n')
  for (let line = 0; line < lines.length; line += 1) {
    const text = lines[line]!
    for (const match of text.matchAll(/!?\[[^\]]*\]\(([^\s)]+)(?:\s+"[^"]*")?\)/g)) {
      add(links, uri, match[1]!, line, match.index! + match[0].indexOf(match[1]!))
    }
    for (const match of text.matchAll(/<((?:https?|mailto):[^>]+)>/g)) {
      add(links, uri, match[1]!, line, match.index! + 1)
    }
    const definition = /^(?: {0,3})\[[^\]]+\]: ([^\s]+)(?:\s+"[^"]*")?/.exec(text)
    if (definition) add(links, uri, definition[1]!, line, text.indexOf(definition[1]!))
  }
  return links
}

function add(links: DocumentLink[], uri: string, destination: string, line: number, character: number): void {
  let target: string
  try {
    target = new URL(destination, uri).toString()
  } catch {
    return
  }
  links.push({
    target,
    tooltip: `Open ${destination}`,
    range: {
      start: { line, character },
      end: { line, character: character + destination.length },
    },
  })
}
