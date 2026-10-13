import path from 'node:path'
import { pathToFileURL } from 'node:url'
import type { IncludePaths } from './include-paths.js'

/** Include child naming against the real filesystem, for the language server. */
export const nodeIncludePaths: IncludePaths = {
  toUri: (file) => pathToFileURL(file).toString(),
  basename: (file) => path.basename(file),
  // Segment-wise, so a sibling directory named `..foo` is not mistaken for an escape.
  relativeToRoot(file, root) {
    const relative = path.relative(root, file)
    if (!relative || path.isAbsolute(relative)) return file
    if (relative.split(path.sep)[0] === '..') return file
    return relative
  },
}
