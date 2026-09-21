/**
 * `carve.previewHtml` over stdio: it expands includes only when an
 * `includeRoot` is configured, and then under every containment rule and bound
 * the diagnostics path enforces (carve-lsp#188).
 */
import assert from 'node:assert/strict'
import test from 'node:test'
import { mkdirSync, mkdtempSync, realpathSync, rmSync, symlinkSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { carveToHtml } from '@markup-carve/carve'
import { LspStdioClient } from './lsp-stdio-client.js'

const serverPath = fileURLToPath(new URL('./server.js', import.meta.url))

const DOCS = {
  expand: '# Book\n\n{{ chapters/one.crv }}\n',
  escape: '{{ ../outside/secret.crv }}\n',
  symlink: '{{ link.crv }}\n',
  directory: '{{ chapters/dir }}\n',
  chain: '{{ chapters/a.crv }}\n',
  twoCalls: '{{ chapters/one.crv }}\n\n{{ chapters/two.crv }}\n',
  bytes: '{{ chapters/one.crv }}\n\n{{ chapters/big.crv }}\n',
  plain: '# Plain\n\nNo _directive_ here.\n',
} as const

type DocName = keyof typeof DOCS

interface Tree {
  project: string
  workspace: string
}

function tree(): Tree {
  const base = realpathSync(mkdtempSync(path.join(tmpdir(), 'carve-lsp-preview-')))
  const project = path.join(base, 'project')
  const workspace = path.join(project, 'ws')
  const chapters = path.join(workspace, 'chapters')
  mkdirSync(path.join(chapters, 'dir'), { recursive: true })
  mkdirSync(path.join(project, 'outside'), { recursive: true })
  writeFileSync(path.join(project, 'outside', 'secret.crv'), 'SECRET-OUTSIDE\n')
  symlinkSync(path.join(project, 'outside', 'secret.crv'), path.join(workspace, 'link.crv'))
  writeFileSync(path.join(chapters, 'one.crv'), 'ONE-BODY\n')
  writeFileSync(path.join(chapters, 'two.crv'), 'TWO-BODY\n')
  writeFileSync(path.join(chapters, 'big.crv'), `BIG-BODY ${'x'.repeat(200)}\n`)
  writeFileSync(path.join(chapters, 'a.crv'), 'A-BODY\n\n{{ b.crv }}\n')
  writeFileSync(path.join(chapters, 'b.crv'), 'B-BODY\n\n{{ c.crv }}\n')
  writeFileSync(path.join(chapters, 'c.crv'), 'C-BODY\n')
  test.after(() => rmSync(base, { recursive: true, force: true }))
  return { project, workspace }
}

interface Session {
  preview: Record<DocName, string>
  /** Where go to definition on the `expand` directive lands, if anywhere. */
  target?: string
}

async function session(
  includes: (built: Tree) => Record<string, unknown>,
  workspaceTrusted = true,
): Promise<Session> {
  const built = tree()
  const client = LspStdioClient.spawnServer(serverPath, built.project)
  const workspaceUri = pathToFileURL(built.workspace).toString()
  await client.request('initialize', {
    processId: null,
    capabilities: {},
    rootUri: workspaceUri,
    workspaceFolders: [{ uri: workspaceUri, name: 'ws' }],
    initializationOptions: { workspaceTrusted, carve: { includes: includes(built) } },
  })
  client.notify('initialized', {})
  const preview = {} as Record<DocName, string>
  let target: string | undefined
  for (const [name, text] of Object.entries(DOCS) as Array<[DocName, string]>) {
    const uri = pathToFileURL(path.join(built.workspace, `${name}.crv`)).toString()
    client.notify('textDocument/didOpen', {
      textDocument: { uri, languageId: 'carve', version: 1, text },
    })
    preview[name] = (await client.request('workspace/executeCommand', {
      command: 'carve.previewHtml',
      arguments: [uri],
    })) as string
    if (name === 'expand') {
      const definition = (await client.request('textDocument/definition', {
        textDocument: { uri },
        position: { line: 2, character: 5 },
      })) as { uri?: string } | null
      if (definition?.uri !== undefined) target = fileURLToPath(definition.uri)
    }
  }
  await client.stop()
  return { preview, ...(target === undefined ? {} : { target }) }
}

const rooted = await session((built) => ({ enabled: 'on', includeRoot: built.workspace }))
const depth = await session((built) => ({ enabled: 'on', includeRoot: built.workspace, maxDepth: 2 }))
const calls = await session((built) => ({
  enabled: 'on',
  includeRoot: built.workspace,
  maxResolverCalls: 1,
}))
const bytes = await session((built) => ({ enabled: 'on', includeRoot: built.workspace, maxBytes: 64 }))
const omitted = await session(() => ({ enabled: 'on' }))
const blank = await session(() => ({ enabled: 'on', includeRoot: '' }))
const off = await session((built) => ({ enabled: 'off', includeRoot: built.workspace }))
const untrusted = await session((built) => ({ includeRoot: built.workspace }), false)

test('with a configured includeRoot the preview renders the merged document', () => {
  assert.equal(rooted.preview.expand, carveToHtml('# Book\n\nONE-BODY\n'))
})

test('a nested child is merged too', () => {
  assert.match(rooted.preview.chain, /A-BODY[\s\S]*B-BODY[\s\S]*C-BODY/)
})

test('a directive escaping the root is not expanded in the preview', () => {
  assert.doesNotMatch(rooted.preview.escape, /SECRET/)
  assert.equal(rooted.preview.escape, carveToHtml(DOCS.escape))
})

test('a symlink out of the root is not expanded in the preview', () => {
  assert.doesNotMatch(rooted.preview.symlink, /SECRET/)
  assert.equal(rooted.preview.symlink, carveToHtml(DOCS.symlink))
})

test('a directory target is not expanded in the preview', () => {
  assert.equal(rooted.preview.directory, carveToHtml(DOCS.directory))
})

test('maxDepth bounds the preview', () => {
  assert.match(depth.preview.chain, /B-BODY/)
  assert.doesNotMatch(depth.preview.chain, /C-BODY/)
})

test('maxResolverCalls bounds the preview', () => {
  assert.match(calls.preview.twoCalls, /ONE-BODY/)
  assert.doesNotMatch(calls.preview.twoCalls, /TWO-BODY/)
})

test('maxBytes bounds the preview', () => {
  assert.match(bytes.preview.bytes, /ONE-BODY/)
  assert.doesNotMatch(bytes.preview.bytes, /BIG-BODY/)
})

test('a document with no directive previews the same with or without a root', () => {
  assert.equal(rooted.preview.plain, carveToHtml(DOCS.plain))
})

for (const [label, observed] of [
  ['an omitted includeRoot', omitted],
  ['a blank includeRoot', blank],
  ['includes switched off', off],
  ['an untrusted workspace', untrusted],
] as const) {
  test(`${label} previews every document byte-identical to carveToHtml of its source`, () => {
    for (const [name, text] of Object.entries(DOCS) as Array<[DocName, string]>) {
      assert.equal(observed.preview[name], carveToHtml(text), name)
    }
  })
}

test('CONTROL: with the root omitted, includes still resolve outside the preview', () => {
  // Without this, "not expanded" would also hold with includes off entirely.
  assert.match(omitted.target ?? '', /chapters\/one\.crv$/)
})

test('CONTROL: switched off, includes resolve nowhere', () => {
  assert.equal(off.target, undefined)
})
