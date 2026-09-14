/**
 * End-to-end containment: what the BUILT SERVER does with the `includeRoot` a
 * client sends it, measured over stdio on a real tree.
 *
 * The defect this pins is not that a bad root is accepted - it is that a bad
 * root RESOLVES A FILE OUTSIDE THE WORKSPACE. `realpathSync('')` returns the
 * process working directory and does not throw, so a client forwarding an
 * unset editor setting roots containment wherever the server happens to have
 * been spawned. Measured on the bundled server from a workspace subdirectory
 * (markup-carve/intellij-carve#130), a blank root resolved a target two levels
 * above the workspace that the same server refused with the key omitted.
 *
 * So every assertion here goes through `textDocument/definition` and
 * `textDocument/diagnostic` on a running server, not through the settings
 * reader. A test that only asserts the reader drops a blank string proves the
 * guard exists; it cannot tell a guard that holds from includes being switched
 * off, which is a separate defect this file also pins (a whitespace-only root
 * used to disable the capability outright, because `realpathSync('   ')`
 * throws).
 */
import assert from 'node:assert/strict'
import test from 'node:test'
import { mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { LspStdioClient } from './lsp-stdio-client.js'

const serverPath = fileURLToPath(new URL('./server.js', import.meta.url))

const OUTSIDE_DOC = '{{ ../../outside/secret.crv }}\n'
const INSIDE_DOC = '{{ ../shared/note.crv }}\n'

interface Tree {
  project: string
  workspace: string
  outsideDoc: string
  insideDoc: string
  secret: string
  note: string
}

/**
 * The layout the measurement used: the server is spawned from the PROJECT
 * directory, the way an editor spawns a bundled server from the project it
 * opened, while the workspace folder it reports is a subdirectory of it. The
 * escape target sits between the two - inside the working directory, outside
 * the workspace - so rooting at the working directory is observable and
 * rooting at the workspace is not merely "narrower", it is correct.
 */
function tree(): Tree {
  const base = realpathSync(mkdtempSync(path.join(tmpdir(), 'carve-lsp-root-')))
  const project = path.join(base, 'project')
  const workspace = path.join(project, 'ws')
  mkdirSync(path.join(workspace, 'deep'), { recursive: true })
  mkdirSync(path.join(workspace, 'shared'), { recursive: true })
  mkdirSync(path.join(project, 'outside'), { recursive: true })
  const outsideDoc = path.join(workspace, 'deep', 'main.crv')
  const insideDoc = path.join(workspace, 'deep', 'neighbor.crv')
  const secret = path.join(project, 'outside', 'secret.crv')
  const note = path.join(workspace, 'shared', 'note.crv')
  writeFileSync(outsideDoc, OUTSIDE_DOC)
  writeFileSync(insideDoc, INSIDE_DOC)
  writeFileSync(secret, '# Secret\n\nNot for the workspace.\n')
  writeFileSync(note, '# Note\n\nA neighbor inside the workspace.\n')
  test.after(() => rmSync(base, { recursive: true, force: true }))
  return { project, workspace, outsideDoc, insideDoc, secret, note }
}

interface Observation {
  /** Canonical path the include resolved to, or undefined when it did not. */
  target?: string
  /** Published include diagnostic codes, in order. */
  codes: string[]
}

interface Session {
  tree: Tree
  outside: Observation
  inside: Observation
  logs: string[]
}

async function observe(
  client: LspStdioClient,
  documentPath: string,
  text: string,
): Promise<Observation> {
  const uri = pathToFileURL(documentPath).toString()
  client.notify('textDocument/didOpen', {
    textDocument: { uri, languageId: 'carve', version: 1, text },
  })
  const report = (await client.request('textDocument/diagnostic', {
    textDocument: { uri },
  })) as { items?: Array<{ code?: unknown }> }
  const definition = (await client.request('textDocument/definition', {
    textDocument: { uri },
    // Inside the directive, past its opening braces.
    position: { line: 0, character: 5 },
  })) as { uri?: string } | null
  const codes = (report.items ?? [])
    .map((item) => String(item.code ?? ''))
    .filter((code) => code.startsWith('include'))
  return {
    ...(definition?.uri === undefined ? {} : { target: fileURLToPath(definition.uri) }),
    codes,
  }
}

/** Drive one server, configured from a fresh tree, over both documents. */
async function session(
  settings: (built: Tree) => Record<string, unknown>,
): Promise<Session> {
  const built = tree()
  const includes = settings(built)
  const client = LspStdioClient.spawnServer(serverPath, built.project)
  const workspaceUri = pathToFileURL(built.workspace).toString()
  await client.request('initialize', {
    processId: null,
    capabilities: {},
    rootUri: workspaceUri,
    workspaceFolders: [{ uri: workspaceUri, name: 'ws' }],
    initializationOptions: { workspaceTrusted: true, carve: { includes } },
  })
  client.notify('initialized', {})
  const outside = await observe(client, built.outsideDoc, OUTSIDE_DOC)
  const inside = await observe(client, built.insideDoc, INSIDE_DOC)
  const logs = client.logMessages().filter((message) => message.includes('includeRoot'))
  await client.stop()
  return { tree: built, outside, inside, logs }
}

const blank = await session(() => ({ enabled: 'on', includeRoot: '' }))
const whitespace = await session(() => ({ enabled: 'on', includeRoot: '   ' }))
const relative = await session(() => ({ enabled: 'on', includeRoot: '.' }))
const relativeEscape = await session(() => ({ enabled: 'on', includeRoot: '..' }))
const omitted = await session(() => ({ enabled: 'on' }))
const absoluteWide = await session((built) => ({ enabled: 'on', includeRoot: built.project }))
const absoluteNarrow = await session((built) => ({
  enabled: 'on',
  includeRoot: path.join(built.workspace, 'deep'),
}))

test('a blank includeRoot does not resolve a target outside the workspace', () => {
  assert.equal(blank.outside.target, undefined)
})

test('a blank includeRoot refuses that target as a denial, not a missing file', () => {
  assert.deepEqual(blank.outside.codes, ['include-denied'])
})

test('a blank includeRoot still resolves a target INSIDE the workspace', () => {
  // Without this, "no leak" would also be satisfied by includes being off.
  assert.equal(blank.inside.target, blank.tree.note)
})

test('a blank includeRoot is reported as ignored rather than silently dropped', () => {
  assert.deepEqual(blank.logs, [
    'Carve: ignoring carve.includes.includeRoot because it is blank; falling back to the workspace root.',
  ])
})

test('a whitespace-only includeRoot does not resolve a target outside the workspace', () => {
  assert.equal(whitespace.outside.target, undefined)
})

test('a whitespace-only includeRoot leaves includes WORKING, not switched off', () => {
  // It used to throw out of `realpathSync` and yield no resolver at all, so
  // the capability vanished silently instead of falling back.
  assert.equal(whitespace.inside.target, whitespace.tree.note)
})

test('a relative includeRoot does not resolve a target outside the workspace', () => {
  assert.equal(relative.outside.target, undefined)
})

test('a relative includeRoot says why it was ignored', () => {
  assert.deepEqual(relative.logs, [
    'Carve: ignoring carve.includes.includeRoot because it is relative ("."),' +
      " and a relative root would resolve against the server's working directory;" +
      ' falling back to the workspace root.',
  ])
})

test('a relative includeRoot naming a parent does not widen the root either', () => {
  // `..` is the spelling that would still escape had a relative root been
  // resolved against the workspace instead of dropped.
  assert.equal(relativeEscape.outside.target, undefined)
})

test('a relative includeRoot still resolves a target inside the workspace', () => {
  assert.equal(relative.inside.target, relative.tree.note)
})

test('CONTROL: an omitted includeRoot still refuses the outside target', () => {
  assert.deepEqual(omitted.outside.codes, ['include-denied'])
})

test('CONTROL: an omitted includeRoot still resolves the inside target', () => {
  assert.equal(omitted.inside.target, omitted.tree.note)
})

test('CONTROL: an omitted includeRoot logs nothing about includeRoot', () => {
  assert.deepEqual(omitted.logs, [])
})

test('CONTROL: an absolute includeRoot wider than the workspace is still honored', () => {
  // The fix drops ambiguous roots; it does not clamp an explicit one. A host
  // that deliberately names a root above the workspace still gets it.
  assert.equal(absoluteWide.outside.target, absoluteWide.tree.secret)
})

test('CONTROL: an absolute includeRoot narrower than the workspace is still honored', () => {
  assert.deepEqual(absoluteNarrow.inside.codes, ['include-denied'])
})

test('CONTROL: an honored absolute includeRoot logs nothing about includeRoot', () => {
  assert.deepEqual(absoluteWide.logs, [])
})
