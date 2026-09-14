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

// ---------------------------------------------------------------------------
// The resolver-call bound (PART 9 §19), configurable like the other two totals
// ---------------------------------------------------------------------------

test('the resolver-call bound is read from the carve.includes section', () => {
  const settings = readIncludeSettings({ carve: { includes: { maxResolverCalls: 25 } } })
  assert.equal(settings.maxResolverCalls, 25)
})

test('a non-numeric resolver-call bound is ignored rather than trusted as given', () => {
  const settings = readIncludeSettings({ carve: { includes: { maxResolverCalls: 'lots' } } })
  assert.equal(settings.maxResolverCalls, undefined)
})

test('an unset resolver-call bound leaves the walk on its own default', () => {
  const settings = readIncludeSettings({ carve: { includes: { enabled: 'on' } } })
  assert.equal(settings.maxResolverCalls, undefined)
})

test('a configured resolver-call bound reaches the walk options', () => {
  const dir = workspace()
  const options = includeOptionsFor({
    uri: pathToFileURL(path.join(dir, 'docs/main.crv')).href,
    settings: { enabled: 'on', maxResolverCalls: 25 },
    workspaceTrusted: true,
    workspaceRoots: [dir],
  })
  assert.equal(options?.maxResolverCalls, 25)
})

test('an unconfigured resolver-call bound is left off the options entirely', () => {
  // Absent rather than undefined-valued, so the walk applies its own default
  // under exactOptionalPropertyTypes.
  const dir = workspace()
  const options = includeOptionsFor({
    uri: pathToFileURL(path.join(dir, 'docs/main.crv')).href,
    settings: { enabled: 'on' },
    workspaceTrusted: true,
    workspaceRoots: [dir],
  })
  assert.ok(options && !('maxResolverCalls' in options))
})

test('the resolver-call bound does not open the capability on its own', () => {
  // §19 opt-in: a bound is a limit, never a grant.
  const dir = workspace()
  const options = includeOptionsFor({
    uri: pathToFileURL(path.join(dir, 'docs/main.crv')).href,
    settings: { enabled: 'auto', maxResolverCalls: 25 },
    workspaceTrusted: false,
    workspaceRoots: [dir],
  })
  assert.equal(options, undefined)
})

/**
 * The reader-level half of the containment fix. The behavior it produces is
 * pinned end-to-end in `include-root-containment.test.ts`, against the running
 * server; these pin the seam and the wording the log carries.
 */
test('a blank includeRoot is read as absent, not as the working directory', () => {
  const settings = readIncludeSettings({ carve: { includes: { enabled: 'on', includeRoot: '' } } })
  assert.equal(settings.includeRoot, undefined)
})

test('a whitespace-only includeRoot is read as absent too', () => {
  const settings = readIncludeSettings({
    carve: { includes: { enabled: 'on', includeRoot: ' \t ' } },
  })
  assert.equal(settings.includeRoot, undefined)
})

test('a relative includeRoot is read as absent, since it has no base but the cwd', () => {
  const settings = readIncludeSettings({
    carve: { includes: { enabled: 'on', includeRoot: 'docs' } },
  })
  assert.equal(settings.includeRoot, undefined)
})

test('dropping a blank includeRoot does not disable includes', () => {
  const settings = readIncludeSettings({ carve: { includes: { enabled: 'on', includeRoot: '' } } })
  assert.equal(settings.enabled, 'on')
})

test('an absolute includeRoot is still read as given', () => {
  const settings = readIncludeSettings({
    carve: { includes: { enabled: 'on', includeRoot: '/ws/docs' } },
  })
  assert.equal(settings.includeRoot, '/ws/docs')
})

test('a dropped includeRoot is logged once, naming the reason', () => {
  const logged: string[] = []
  readIncludeSettings({ carve: { includes: { includeRoot: '' } } }, (m) => logged.push(m))
  assert.deepEqual(logged, [
    'Carve: ignoring carve.includes.includeRoot because it is blank; falling back to the workspace root.',
  ])
})

test('a dropped relative includeRoot names the value it dropped', () => {
  const logged: string[] = []
  readIncludeSettings({ carve: { includes: { includeRoot: 'docs' } } }, (m) => logged.push(m))
  assert.match(logged[0] ?? '', /relative \("docs"\)/)
})

test('an honored includeRoot logs nothing', () => {
  const logged: string[] = []
  readIncludeSettings({ carve: { includes: { includeRoot: '/ws' } } }, (m) => logged.push(m))
  assert.deepEqual(logged, [])
})

test('a blank includeRoot reaching includeOptionsFor directly falls back as well', () => {
  // `readIncludeSettings` is not the only way an `IncludeSettings` is built;
  // the containment decision is owned here, so the guard is here too.
  const dir = workspace()
  const options = includeOptionsFor({
    uri: pathToFileURL(path.join(dir, 'docs/main.crv')).href,
    settings: { enabled: 'on', includeRoot: '' },
    workspaceTrusted: true,
    workspaceRoots: [dir],
  })
  assert.equal(options?.includeRoot, dir)
})

test('a relative includeRoot reaching includeOptionsFor directly falls back as well', () => {
  const dir = workspace()
  const options = includeOptionsFor({
    uri: pathToFileURL(path.join(dir, 'docs/main.crv')).href,
    settings: { enabled: 'on', includeRoot: 'docs' },
    workspaceTrusted: true,
    workspaceRoots: [dir],
  })
  assert.equal(options?.includeRoot, dir)
})
