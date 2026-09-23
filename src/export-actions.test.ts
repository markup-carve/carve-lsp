import assert from 'node:assert/strict'
import test from 'node:test'
import {
  EXPORT_KIND,
  exportCodeActions,
  exportSupport,
  exportTarget,
  resolveExportAction,
  type ExportFormat,
} from './export-actions.js'

const full = { createFile: true, resolveEdit: true }
const render = (format: ExportFormat) => `rendered ${format}`
const missing = () => null

test('derives the sibling target from the source uri', () => {
  assert.equal(exportTarget('file:///docs/notes.crv', 'markdown'), 'file:///docs/notes.md')
  assert.equal(exportTarget('file:///docs/NOTES.CRV', 'html'), 'file:///docs/NOTES.html')
  assert.equal(exportTarget('file:///docs/notes', 'markdown'), 'file:///docs/notes.md')
  assert.equal(exportTarget('untitled:Untitled-1', 'markdown'), null)
})

test('reads create and resolve support from client capabilities', () => {
  assert.deepEqual(exportSupport({}), { createFile: false, resolveEdit: false })
  assert.deepEqual(
    exportSupport({
      workspace: { workspaceEdit: { documentChanges: true, resourceOperations: ['create', 'rename'] } },
      textDocument: { codeAction: { resolveSupport: { properties: ['edit'] } } },
    }),
    { createFile: true, resolveEdit: true },
  )
  assert.equal(
    exportSupport({ workspace: { workspaceEdit: { documentChanges: false, resourceOperations: ['create'] } } }).createFile,
    false,
  )
})

test('offers nothing when the client cannot create files', () => {
  assert.deepEqual(exportCodeActions('file:///a.crv', { createFile: false, resolveEdit: true }, undefined, render, missing), [])
})

test('defers rendering to resolve when the client supports it', () => {
  let renders = 0
  const actions = exportCodeActions('file:///a.crv', full, undefined, (format) => {
    renders++
    return render(format)
  }, missing)
  assert.equal(renders, 0)
  assert.deepEqual(actions.map((action) => [action.title, action.kind, action.edit]), [
    ['Export as Markdown', EXPORT_KIND, undefined],
    ['Export as HTML', EXPORT_KIND, undefined],
  ])

  const resolved = resolveExportAction(actions[0]!, (uri, format) => `${uri} as ${format}`, missing)
  assert.deepEqual(resolved.edit, {
    documentChanges: [
      { kind: 'create', uri: 'file:///a.md' },
      {
        textDocument: { uri: 'file:///a.md', version: null },
        edits: [{ range: { start: { line: 0, character: 0 }, end: { line: 0, character: 0 } }, newText: 'file:///a.crv as markdown' }],
      },
    ],
  })
})

test('renders eagerly without resolve support', () => {
  const [markdown] = exportCodeActions('file:///a.crv', { createFile: true, resolveEdit: false }, undefined, render, missing)
  const fill = markdown?.edit?.documentChanges?.[1]
  assert.ok(fill && 'edits' in fill)
  assert.equal(fill.edits[0]?.newText, 'rendered markdown')
})

test('honors the requested kinds filter', () => {
  assert.equal(exportCodeActions('file:///a.crv', full, ['quickfix'], render, missing).length, 0)
  assert.equal(exportCodeActions('file:///a.crv', full, ['source'], render, missing).length, 2)
  assert.equal(exportCodeActions('file:///a.crv', full, [EXPORT_KIND], render, missing).length, 2)
})

test('leaves foreign actions and vanished documents untouched', () => {
  const foreign = { title: 'other', data: { something: 1 } }
  assert.equal(resolveExportAction(foreign, () => 'x', missing), foreign)
  const [action] = exportCodeActions('file:///a.crv', full, undefined, render, missing)
  assert.equal(resolveExportAction(action!, () => null, missing).edit, undefined)
})

test('replaces an existing target instead of creating it again', () => {
  const [action] = exportCodeActions('file:///a.crv', full, undefined, render, missing)
  const resolved = resolveExportAction(action!, () => 'new', () => 'old line\nsecond line\n')
  assert.deepEqual(resolved.edit, {
    documentChanges: [
      {
        textDocument: { uri: 'file:///a.md', version: null },
        edits: [{ range: { start: { line: 0, character: 0 }, end: { line: 2, character: 0 } }, newText: 'new' }],
      },
    ],
  })
})
