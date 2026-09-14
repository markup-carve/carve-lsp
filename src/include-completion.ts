/**
 * Completion inside a `{{ … }}` include directive: the path, the `#section`
 * it selects, and the option names and value shapes.
 *
 * Every slot is recognized against the SAME grammar the scanner enforces
 * (`./include-directive.js`). A completion that inserts a spelling the scanner
 * rejects is worse than no completion at all: the directive silently stops
 * being a directive, with no include and no diagnostic - the exact failure
 * this feature exists to prevent.
 */
import { readdirSync, readFileSync, realpathSync } from 'node:fs'
import path from 'node:path'
import {
  CompletionItemKind,
  type CompletionItem,
  type Position,
} from 'vscode-languageserver/node.js'
import type { IncludeOptions } from './includes.js'
import { lineCount, sections } from './include-selection.js'

/**
 * The option names §19 defines, with the value shapes worth offering. The
 * line range has no fixed values, so its shape is completed from the child's
 * own length; the shift offset does, and `auto` is the one authors do not
 * discover on their own.
 */
const OPTION_NAMES = [
  { name: 'lines', detail: 'Select a line range, N-M' },
  { name: 'shift', detail: 'Shift heading levels by N, or auto' },
] as const

/** Text between the innermost unclosed `{{` and the cursor, or null. */
function directiveInner(prefix: string): string | null {
  const open = prefix.lastIndexOf('{{')
  if (open < 0) return null
  const inner = prefix.slice(open + 2)
  return inner.includes('}}') ? null : inner
}

/**
 * A complete path token, in every spelling the scanner accepts: bare, straight
 * quoted, or curly quoted. A quoted path is the only way to name a file whose
 * name contains a space, so a pattern that only matched the bare form would
 * drop completion on exactly the directives that need the quotes.
 */
const PATH_TOKEN = '(?:"(?:\\\\.|[^"\\\\])*"|\u201c[^\u201d]*\u201d|[^\\s#@}"\u201c]+)'

/** `{{ <path>` with nothing selected yet. */
const PATH_RE = /^(\s*)([^\s#@}"\u201c]*)$/
/**
 * `{{ "<path>` mid-typing, before the closing quote exists. The opening
 * delimiter is captured because the two quote styles do not close each other:
 * a curly-opened path closed with a straight quote is not a directive.
 */
const QUOTED_PATH_RE = /^\s*(["\u201c])([^"\u201d]*)$/

const CLOSING_QUOTE: Readonly<Record<string, string>> = { '"': '"', '\u201c': '\u201d' }
/** `{{ <path> #<fragment>`, and the ungrammatical `{{ <path>#<fragment>`. */
const FRAGMENT_RE = new RegExp(`^\\s*(${PATH_TOKEN})(\\s*)#([A-Za-z_][\\w-]*)?$`)
/** The leading path of a directive, however it is spelled. */
const LEADING_PATH_RE = new RegExp(`^\\s*(${PATH_TOKEN})`)
/**
 * Everything that may legally precede an option: a path, an optional section,
 * and options that are themselves complete. Without this an option would be
 * offered after arbitrary text (`{{ ch1.crv nonsense @`), and taking it would
 * leave a token the scanner refuses - the directive silently becoming prose,
 * which is the one outcome this module exists to avoid.
 */
const OPTION_PREFIX_RE = new RegExp(
  `^\\s*${PATH_TOKEN}(?:\\s+#[A-Za-z_][\\w-]*)?(?:\\s+@[A-Za-z_][\\w-]*:[^\\s#@}]+)*\\s*$`,
)

/** `{{ <path> … @<name>`, with whatever separator precedes the sigil. */
const OPTION_NAME_RE = /(\s*)@([A-Za-z_][\w-]*)?$/
/** `{{ <path> … @<name>:<value>` */
const OPTION_VALUE_RE = /@([A-Za-z_][\w-]*):([^\s#@}]*)$/

/** A path token as the scanner reads it: quotes stripped, escapes undone. */
function decodePath(token: string): string {
  if (token.startsWith('"')) {
    return token.slice(1, token.endsWith('"') ? -1 : undefined).replace(/\\(["\\])/g, '$1')
  }
  if (token.startsWith('\u201c')) return token.slice(1, token.endsWith('\u201d') ? -1 : undefined)
  return token
}

export function includeCompletions(
  source: string,
  position: Position,
  options?: IncludeOptions,
): CompletionItem[] {
  if (!options?.sourcePath || !options.includeRoot) return []
  const line = source.replace(/\r\n?/g, '\n').split('\n')[position.line] ?? ''
  const inner = directiveInner(line.slice(0, position.character))
  if (inner === null) return []
  const root = realpathSafe(options.includeRoot)
  if (!root) return []

  const value = OPTION_VALUE_RE.exec(inner)
  if (value) {
    return OPTION_PREFIX_RE.test(inner.slice(0, value.index))
      ? optionValues(inner, value, position, options, root)
      : []
  }

  const name = OPTION_NAME_RE.exec(inner)
  if (name) {
    return OPTION_PREFIX_RE.test(inner.slice(0, name.index))
      ? optionNames(inner, name, position)
      : []
  }

  const fragment = FRAGMENT_RE.exec(inner)
  if (fragment) return fragments(fragment, position, options, root)

  const quoted = QUOTED_PATH_RE.exec(inner)
  if (quoted) return paths(quoted[2]!, position, options, root, CLOSING_QUOTE[quoted[1]!])

  const asPath = PATH_RE.exec(inner)
  return asPath ? paths(asPath[2]!, position, options, root, undefined) : []
}

/** A path the bare token cannot spell, so the directive has to quote it. */
function needsQuoting(value: string): boolean {
  return /["\u201c\u201d#@}\s]/.test(value)
}

function escapeQuoted(value: string): string {
  return value.replace(/(["\\])/g, '\\$1')
}

function quote(value: string): string {
  return `"${escapeQuoted(value)}"`
}

/**
 * Files and directories under the containment root, filtered to `.crv`.
 *
 * `closer` is set when the author already opened a quoted path: the edit then
 * stays inside the quotes and closes them with the delimiter that MATCHES the
 * opening one, once a FILE is chosen. A name that cannot be spelled bare is
 * quoted on the author's behalf instead, whole path and all - quoting is a
 * property of the token, not of its last segment.
 */
function paths(
  filePart: string,
  position: Position,
  options: IncludeOptions,
  root: string,
  closer: string | undefined,
): CompletionItem[] {
  // Split on the last separator rather than through `path.dirname`, which maps
  // a trailing "sub/" to "." and would list the PARENT of the directory the
  // author just opened. The backslash counts only where the platform treats it
  // as a separator; on POSIX it is a legal character in a file name.
  const slash = Math.max(
    filePart.lastIndexOf('/'),
    path.sep === '\\' ? filePart.lastIndexOf('\\') : -1,
  )
  const prefix = slash < 0 ? '' : filePart.slice(0, slash + 1)
  const partial = slash < 0 ? filePart : filePart.slice(slash + 1)

  const base = path.resolve(path.dirname(options.sourcePath!), prefix || '.')
  const contained = realpathSafe(base)
  if (!contained || !isInside(root, contained)) return []

  let entries
  try {
    entries = readdirSync(contained, { withFileTypes: true })
  } catch {
    return []
  }
  return entries
    .filter((entry) => entry.name.startsWith(partial) && (entry.isDirectory() || entry.name.endsWith('.crv')))
    .map((entry) => {
      const directory = entry.isDirectory()
      const label = entry.name + (directory ? '/' : '')
      const full = prefix + label
      let start = position.character - partial.length
      let newText = label
      if (closer !== undefined) {
        // Stay inside the quotes the author opened, and close them only once a
        // FILE is chosen - a directory is a step on the way, not a whole path.
        start = position.character - filePart.length
        newText = directory ? full : `${full}${closer}`
      } else if (needsQuoting(full)) {
        start = position.character - filePart.length
        newText = directory ? `"${escapeQuoted(full)}` : quote(full)
      }
      return item(
        label,
        directory ? CompletionItemKind.Folder : CompletionItemKind.File,
        position,
        start,
        'Contained include path',
        newText,
      )
    })
}

/**
 * Heading ids in the file the directive already names.
 *
 * The inserted text always carries the separating space, whether or not the
 * author typed one. `{{ ch1.crv#intro }}` is NOT a directive - the scanner's
 * path token stops at `#` and the remainder parses as a bad option - so
 * completing into that spelling would hand back literal text. Detecting it and
 * repairing it turns the trigger character into a fix rather than a trap.
 */
function fragments(
  match: RegExpExecArray,
  position: Position,
  options: IncludeOptions,
  root: string,
): CompletionItem[] {
  const filePart = decodePath(match[1]!)
  const tail = match[2]!.length + 1 + (match[3] ?? '').length
  const target = realpathSafe(path.resolve(path.dirname(options.sourcePath!), filePart))
  if (!target || !isInside(root, target)) return []
  const source = readSafe(target)
  if (source === null) return []
  const start = position.character - tail
  return sections(source).map((section) =>
    item(`#${section.id}`, CompletionItemKind.Reference, position, start, 'Section in included file', ` #${section.id}`),
  )
}

/**
 * Option names §19 defines, minus any the directive already carries.
 *
 * Options are whitespace-separated, so the inserted text carries the separator
 * whether or not the author typed one - `{{ ch1.crv @shift:1@lines:2-3 }}` is
 * one unparsable option token, not two, and completing into it would hand back
 * literal text for the same reason the unspaced fragment does.
 */
function optionNames(inner: string, match: RegExpExecArray, position: Position): CompletionItem[] {
  const separator = match[1]!
  const typed = match[2] ?? ''
  const tail = separator.length + 1 + typed.length
  const before = inner.slice(0, inner.length - tail)
  const start = position.character - tail
  return OPTION_NAMES.filter((option) => !new RegExp(`@${option.name}:`).test(before)).map((option) =>
    item(
      `@${option.name}:`,
      CompletionItemKind.Property,
      position,
      start,
      option.detail,
      ` @${option.name}:`,
    ),
  )
}

/** Value shapes for the option being typed. */
function optionValues(
  inner: string,
  match: RegExpExecArray,
  position: Position,
  options: IncludeOptions,
  root: string,
): CompletionItem[] {
  const name = match[1]!
  const start = position.character - match[2]!.length
  if (name === 'shift') {
    return [
      item('auto', CompletionItemKind.Value, position, start, 'Fit heading levels to the include site'),
      item('+1', CompletionItemKind.Value, position, start, 'Shift headings one level deeper'),
      item('-1', CompletionItemKind.Value, position, start, 'Shift headings one level shallower'),
    ]
  }
  if (name !== 'lines') return []
  // The only range worth guessing is the whole file, and it is only worth
  // offering because it also tells the author how long the child actually is.
  const token = LEADING_PATH_RE.exec(inner)?.[1]
  if (!token) return []
  const filePart = decodePath(token)
  const target = realpathSafe(path.resolve(path.dirname(options.sourcePath!), filePart))
  if (!target || !isInside(root, target)) return []
  const source = readSafe(target)
  if (source === null) return []
  const total = lineCount(source)
  // An empty target has no line to select, and `1-0` is not a range the
  // scanner accepts, so there is nothing honest to offer.
  if (total === 0) return []
  return [item(`1-${total}`, CompletionItemKind.Value, position, start, `Whole file (${total} lines)`)]
}

function item(
  label: string,
  kind: CompletionItemKind,
  position: Position,
  start: number,
  detail: string,
  newText = label,
): CompletionItem {
  return {
    label,
    kind,
    detail,
    textEdit: {
      range: { start: { line: position.line, character: start }, end: position },
      newText,
    },
  }
}

function readSafe(target: string): string | null {
  try {
    return readFileSync(target, 'utf8')
  } catch {
    return null
  }
}

function realpathSafe(value: string): string | null {
  try {
    return realpathSync(value)
  } catch {
    return null
  }
}

function isInside(root: string, target: string): boolean {
  const relative = path.relative(root, target)
  return relative === '' || (!path.isAbsolute(relative) && !relative.split(path.sep).includes('..'))
}
