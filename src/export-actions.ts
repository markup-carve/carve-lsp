import {
  CodeActionKind,
  CreateFile,
  Position,
  Range,
  TextDocumentEdit,
  TextEdit,
  type CodeAction,
  type WorkspaceEdit,
} from 'vscode-languageserver/node.js'

export type ExportFormat = 'markdown' | 'html'

export const EXPORT_KIND = `${CodeActionKind.Source}.export`

const FORMATS: Record<ExportFormat, { title: string, extension: string }> = {
  markdown: { title: 'Export as Markdown', extension: '.md' },
  html: { title: 'Export as HTML', extension: '.html' },
}

export interface ExportActionData {
  carveExport: ExportFormat
  uri: string
}

/** What the client declared it can do with export actions. */
export interface ExportSupport {
  /** `workspaceEdit.documentChanges` plus the `create` resource operation. */
  createFile: boolean
  /** `codeAction/resolve` may fill in `edit`, so rendering can wait. */
  resolveEdit: boolean
}

export function exportSupport(capabilities: {
  workspace?: { workspaceEdit?: { documentChanges?: boolean, resourceOperations?: string[] } }
  textDocument?: { codeAction?: { resolveSupport?: { properties?: string[] } } }
}): ExportSupport {
  const workspaceEdit = capabilities.workspace?.workspaceEdit
  return {
    createFile: Boolean(workspaceEdit?.documentChanges) && (workspaceEdit?.resourceOperations ?? []).includes('create'),
    resolveEdit: (capabilities.textDocument?.codeAction?.resolveSupport?.properties ?? []).includes('edit'),
  }
}

/** The sibling file an export writes: `notes.crv` becomes `notes.md`. */
export function exportTarget(uri: string, format: ExportFormat): string | null {
  if (!uri.startsWith('file:')) return null
  const { extension } = FORMATS[format]
  return /\.crv$/i.test(uri) ? uri.replace(/\.crv$/i, extension) : `${uri}${extension}`
}

/**
 * Source actions that write the rendered document next to the source. With
 * resolve support the action carries only `data` and the render happens in
 * `resolveExportAction`, so a cursor move never pays for a full render.
 */
export function exportCodeActions(
  uri: string,
  support: ExportSupport,
  only: string[] | undefined,
  render: (format: ExportFormat) => string,
  existing: (target: string) => string | null,
): CodeAction[] {
  if (!support.createFile) return []
  if (only && !only.some((kind) => EXPORT_KIND === kind || EXPORT_KIND.startsWith(`${kind}.`))) return []
  const actions: CodeAction[] = []
  for (const format of Object.keys(FORMATS) as ExportFormat[]) {
    if (!exportTarget(uri, format)) continue
    const action: CodeAction = { title: FORMATS[format].title, kind: EXPORT_KIND }
    if (support.resolveEdit) {
      action.data = { carveExport: format, uri } satisfies ExportActionData
    } else {
      action.edit = exportEdit(uri, format, render(format), existing) ?? undefined
    }
    actions.push(action)
  }
  return actions
}

export function isExportAction(data: unknown): data is ExportActionData {
  const candidate = data as Partial<ExportActionData> | null
  return typeof candidate?.uri === 'string'
    && (candidate.carveExport === 'markdown' || candidate.carveExport === 'html')
}

export function resolveExportAction(
  action: CodeAction,
  render: (uri: string, format: ExportFormat) => string | null,
  existing: (target: string) => string | null,
): CodeAction {
  if (!isExportAction(action.data)) return action
  const { uri, carveExport } = action.data
  const content = render(uri, carveExport)
  if (content === null) return action
  const edit = exportEdit(uri, carveExport, content, existing)
  return edit ? { ...action, edit } : action
}

/**
 * Replace an existing target wholesale; create a missing one. `overwrite` on
 * `CreateFile` is not enough: Zed keeps the old content and the insert lands
 * in front of it.
 */
export function exportEdit(
  uri: string,
  format: ExportFormat,
  content: string,
  existing: (target: string) => string | null,
): WorkspaceEdit | null {
  const target = exportTarget(uri, format)
  if (!target) return null
  const current = existing(target)
  const fill = TextDocumentEdit.create({ uri: target, version: null }, [
    TextEdit.replace(Range.create(Position.create(0, 0), endOf(current ?? '')), content),
  ])
  return { documentChanges: current === null ? [CreateFile.create(target), fill] : [fill] }
}

function endOf(text: string): Position {
  const lines = text.split(/\r\n|\r|\n/)
  return Position.create(lines.length - 1, lines[lines.length - 1]!.length)
}
