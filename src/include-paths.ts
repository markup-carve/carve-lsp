/**
 * How include children are named for a client: a URI to open, a short name,
 * and the path relative to the include root. The language server passes the
 * Node implementation (`node-include-paths.ts`); without one the portable
 * fallback below applies, so the analysis modules import no Node built-in.
 */
export interface IncludePaths {
  toUri(file: string): string
  basename(file: string): string
  /** `file` relative to `root`, or `file` itself when it is not under the root. */
  relativeToRoot(file: string, root: string): string
}

export const portableIncludePaths: IncludePaths = {
  toUri(file) {
    if (/^[a-z][a-z0-9+.-]*:/i.test(file) && !/^[a-z]:[\\/]/i.test(file)) return file
    const slashed = file.replace(/\\/g, '/')
    // encodeURI leaves `#` and `?`, which would turn the rest of the path into a fragment or query.
    return 'file://' + (slashed.startsWith('/') ? '' : '/') + encodeURI(slashed).replace(/#/g, '%23').replace(/\?/g, '%3F')
  },
  basename(file) {
    return file.split(/[\\/]/).pop() ?? file
  },
  relativeToRoot(file, root) {
    const prefix = root.replace(/[\\/]+$/, '') + '/'
    const slashed = file.replace(/\\/g, '/')
    return slashed.startsWith(prefix.replace(/\\/g, '/')) && slashed.length > prefix.length ? slashed.slice(prefix.length) : file
  },
}
