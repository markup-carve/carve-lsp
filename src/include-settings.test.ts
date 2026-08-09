import assert from 'node:assert/strict'
import test from 'node:test'
import { mkdirSync, mkdtempSync, realpathSync, rmSync, symlinkSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { pathToFileURL } from 'node:url'
import {
  includeOptionsFor,
  readIncludeSettings,
  readWorkspaceTrusted,
  type IncludeSettings,
} from './include-settings.js'

function workspace(): string {
  const dir = realpathSync(mkdtempSync(path.join(tmpdir(), 'carve-lsp-ws-')))
  mkdirSync(path.join(dir, 'docs'), { recursive: true })
  writeFileSync(path.join(dir, 'docs/main.crv'), '{{ child.crv }}\n')
  writeFileSync(path.join(dir, 'docs/child.crv'), 'Child.\n')
  test.after(() => rmSync(dir, { recursive: true, force: true }))
  return dir
}

const AUTO: IncludeSettings = { enabled: 'auto' }

// ---------------------------------------------------------------------------
// §19: "MUST treat includes as opt-in (off for untrusted input)"
// ---------------------------------------------------------------------------

test('the default is OFF: auto plus an untrusted workspace yields no capability', () => {
  const dir = workspace()
  const options = includeOptionsFor({
    uri: pathToFileURL(path.join(dir, 'docs/main.crv')).href,
    settings: AUTO,
    workspaceTrusted: false,
    workspaceRoots: [dir],
  })
  assert.equal(options, undefined)
})

test('a client that says nothing about trust is treated as untrusted', () => {
  assert.equal(readWorkspaceTrusted(undefined), false)
  assert.equal(readWorkspaceTrusted({}), false)
  assert.equal(readWorkspaceTrusted({ workspaceTrusted: 'yes' }), false)
  assert.equal(readWorkspaceTrusted({ workspaceTrusted: true }), true)
})

test('auto plus a trusted workspace yields a resolver rooted at the workspace', () => {
  const dir = workspace()
  const options = includeOptionsFor({
    uri: pathToFileURL(path.join(dir, 'docs/main.crv')).href,
    settings: AUTO,
    workspaceTrusted: true,
    workspaceRoots: [dir],
  })
  assert.ok(options?.resolver)
  assert.equal(options.includeRoot, dir)
  assert.equal(options.sourcePath, path.join(dir, 'docs/main.crv'))
})

test('off wins over a trusted workspace', () => {
  const dir = workspace()
  const options = includeOptionsFor({
    uri: pathToFileURL(path.join(dir, 'docs/main.crv')).href,
    settings: { enabled: 'off' },
    workspaceTrusted: true,
    workspaceRoots: [dir],
  })
  assert.equal(options, undefined)
})

test('on enables includes without a trust report', () => {
  const dir = workspace()
  const options = includeOptionsFor({
    uri: pathToFileURL(path.join(dir, 'docs/main.crv')).href,
    settings: { enabled: 'on' },
    workspaceTrusted: false,
    workspaceRoots: [dir],
  })
  assert.ok(options?.resolver)
})

// ---------------------------------------------------------------------------
// Containment root selection
// ---------------------------------------------------------------------------

test('a file opened outside any workspace is rooted at its own directory, never the cwd', () => {
  const dir = workspace()
  const options = includeOptionsFor({
    uri: pathToFileURL(path.join(dir, 'docs/main.crv')).href,
    settings: { enabled: 'on' },
    workspaceTrusted: false,
  })
  assert.equal(options?.includeRoot, path.join(dir, 'docs'))
  assert.notEqual(options?.includeRoot, process.cwd())
})

test('a document is rooted at the workspace folder that contains it, not the first one', () => {
  const dir = workspace()
  const other = workspace()
  const options = includeOptionsFor({
    uri: pathToFileURL(path.join(dir, 'docs/main.crv')).href,
    settings: { enabled: 'on' },
    workspaceTrusted: true,
    // The containing folder is listed second on purpose.
    workspaceRoots: [other, dir],
  })
  assert.equal(options?.includeRoot, dir)
})

test('a document in none of the workspace folders falls back to its own directory', () => {
  const dir = workspace()
  const other = workspace()
  const options = includeOptionsFor({
    uri: pathToFileURL(path.join(dir, 'docs/main.crv')).href,
    settings: { enabled: 'on' },
    workspaceTrusted: true,
    workspaceRoots: [other],
  })
  assert.equal(options?.includeRoot, path.join(dir, 'docs'))
})

test('the deepest containing workspace folder wins', () => {
  const dir = workspace()
  const options = includeOptionsFor({
    uri: pathToFileURL(path.join(dir, 'docs/main.crv')).href,
    settings: { enabled: 'on' },
    workspaceTrusted: true,
    workspaceRoots: [dir, path.join(dir, 'docs')],
  })
  assert.equal(options?.includeRoot, path.join(dir, 'docs'))
})

test('an explicit includeRoot wins over the workspace root', () => {
  const dir = workspace()
  const options = includeOptionsFor({
    uri: pathToFileURL(path.join(dir, 'docs/main.crv')).href,
    settings: { enabled: 'on', includeRoot: path.join(dir, 'docs') },
    workspaceTrusted: true,
    workspaceRoots: [dir],
  })
  assert.equal(options?.includeRoot, path.join(dir, 'docs'))
})

test('a root reached through a symlink is reported canonically', () => {
  // The resolver returns canonical child ids. If `includeRoot` were the
  // uncanonical spelling, every child would look like it sits outside the root
  // and a diagnostic naming one would print an absolute filesystem path.
  const dir = workspace()
  const link = path.join(path.dirname(dir), `${path.basename(dir)}-link`)
  symlinkSync(dir, link)
  test.after(() => rmSync(link, { force: true }))
  const options = includeOptionsFor({
    uri: pathToFileURL(path.join(dir, 'docs/main.crv')).href,
    settings: { enabled: 'on', includeRoot: link },
    workspaceTrusted: true,
  })
  assert.equal(options?.includeRoot, dir)
})

test('a root that is not a real directory yields no capability rather than a wider one', () => {
  const dir = workspace()
  const options = includeOptionsFor({
    uri: pathToFileURL(path.join(dir, 'docs/main.crv')).href,
    settings: { enabled: 'on', includeRoot: path.join(dir, 'does-not-exist') },
    workspaceTrusted: true,
    workspaceRoots: [dir],
  })
  assert.equal(options, undefined)
})

test('a document with no filesystem identity gets no capability', () => {
  const options = includeOptionsFor({
    uri: 'untitled:Untitled-1',
    settings: { enabled: 'on' },
    workspaceTrusted: true,
    workspaceRoots: ['/tmp'],
  })
  assert.equal(options, undefined)
})

// ---------------------------------------------------------------------------
// Settings parsing
// ---------------------------------------------------------------------------

test('an absent or unrecognized settings payload falls back to the default', () => {
  assert.deepEqual(readIncludeSettings(undefined), { enabled: 'auto' })
  assert.deepEqual(readIncludeSettings({}), { enabled: 'auto' })
  assert.deepEqual(readIncludeSettings({ carve: { includes: { enabled: 'yes please' } } }), {
    enabled: 'auto',
  })
})

test('settings are read from the carve.includes section', () => {
  const settings = readIncludeSettings({
    carve: {
      includes: {
        enabled: 'on',
        includeRoot: '/ws',
        allowAbsolute: true,
        allowedRemoteHosts: ['example.com', 7],
        maxDepth: 4,
        maxBytes: 2048,
      },
    },
  })
  assert.deepEqual(settings, {
    enabled: 'on',
    includeRoot: '/ws',
    allowAbsolute: true,
    // Non-string hosts are dropped rather than trusted as given.
    allowedRemoteHosts: ['example.com'],
    maxDepth: 4,
    maxBytes: 2048,
  })
})
