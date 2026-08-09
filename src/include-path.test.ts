import assert from 'node:assert/strict'
import test from 'node:test'
import { mkdirSync, mkdtempSync, realpathSync, rmSync, symlinkSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { fileSystemResolver, type IncludeContext } from './include-path.js'

// PART 9 §19 puts four MUSTs on path resolution. Each has a test here, and
// each was proven load-bearing by deleting its guard in `include-path.ts` and
// watching THIS test go red (see the pull request for the transcript).
//
// Expectations follow the cross-engine include-conformance vectors
// `i10-fs-*` in markup-carve/carve, which currently live only on the unmerged
// spec branch for markup-carve/carve#291. They are cited, not vendored.

const CTX: IncludeContext = { stack: [], depth: 0 }

function fixture(tree: Record<string, string | { symlink: string }>): string {
  const dir = realpathSync(mkdtempSync(path.join(tmpdir(), 'carve-lsp-inc-')))
  for (const [name, value] of Object.entries(tree)) {
    const full = path.join(dir, name)
    mkdirSync(path.dirname(full), { recursive: true })
    if (typeof value === 'string') writeFileSync(full, value)
    else symlinkSync(path.join(dir, value.symlink), full)
  }
  test.after(() => rmSync(dir, { recursive: true, force: true }))
  return dir
}

// ---------------------------------------------------------------------------
// MUST 1: resolve only under the root AFTER symlink resolution
// ---------------------------------------------------------------------------

test('a symlinked DIRECTORY escaping the root is denied (i10-fs-symlink-dir-escape-denied)', () => {
  const dir = fixture({
    'root/main.crv': '{{ linkdir/secret.crv }}\n',
    'outside/secret.crv': 'TOP SECRET\n',
    'root/linkdir': { symlink: 'outside' },
  })
  const resolve = fileSystemResolver(path.join(dir, 'root'))
  const result = resolve('linkdir/secret.crv', CTX)
  assert.equal(result.ok, false)
  assert.equal(result.ok === false && result.denial, 'outside-root')
  // The dependency id is the path as written, never the real path behind it.
  assert.equal(result.id, 'linkdir/secret.crv')
})

test('a symlinked FILE whose real target escapes the root is denied (i10-fs-symlink-file-and-dotdot-denied)', () => {
  const dir = fixture({
    'root/main.crv': '{{ link.crv }}\n',
    'secret.crv': 'TOP SECRET\n',
    'root/link.crv': { symlink: 'secret.crv' },
  })
  const resolve = fileSystemResolver(path.join(dir, 'root'))
  const result = resolve('link.crv', CTX)
  assert.equal(result.ok, false)
  assert.equal(result.ok === false && result.denial, 'outside-root')
})

// ---------------------------------------------------------------------------
// MUST 2: reject `..`-traversal that leaves the root
// ---------------------------------------------------------------------------

test('a ../ escape out of the root is denied (i10-fs-dotdot-escape-denied)', () => {
  const dir = fixture({
    'root/main.crv': '{{ ../secret.crv }}\n',
    'secret.crv': 'TOP SECRET\n',
  })
  const resolve = fileSystemResolver(path.join(dir, 'root'))
  const result = resolve('../secret.crv', CTX)
  assert.equal(result.ok, false)
  assert.equal(result.ok === false && result.denial, 'outside-root')
})

test('a ../ path whose canonical target stays INSIDE the root resolves (i10-fs-dotdot-inside-root-allowed)', () => {
  // Control for the test above: the guard is canonical containment, not a
  // lexical ban on `..`. A book layout that reaches a sibling directory is
  // legal and must keep working. No mutation of the containment check breaks
  // this case - deleting the check makes it pass just as well - so it is
  // stated here as the boundary the guard must NOT overreach, not as proof.
  const dir = fixture({
    'chapters/ch1.crv': 'Chapter one.\n',
    'shared/glossary.crv': 'Glossary body.\n',
  })
  const resolve = fileSystemResolver(dir)
  const result = resolve('../shared/glossary.crv', {
    stack: [path.join(dir, 'chapters/ch1.crv')],
    depth: 1,
  })
  assert.equal(result.ok, true)
  assert.equal(result.ok === true && result.source, 'Glossary body.\n')
})

// ---------------------------------------------------------------------------
// MUST 3: reject absolute paths that escape the root
// ---------------------------------------------------------------------------

test('an absolute path outside the root is denied even with allowAbsolute (i10-fs-absolute-path-denied)', () => {
  // With absolute paths explicitly enabled, containment is the ONLY thing
  // standing between the directive and the file, which is what makes this the
  // test for the MUST rather than for the convenience default below.
  const dir = fixture({
    'root/main.crv': 'x\n',
    'secret.crv': 'TOP SECRET\n',
  })
  const resolve = fileSystemResolver(path.join(dir, 'root'), { allowAbsolute: true })
  const result = resolve(path.join(dir, 'secret.crv'), CTX)
  assert.equal(result.ok, false)
  assert.equal(result.ok === false && result.denial, 'outside-root')
})

test('an absolute path is denied by default, before containment is consulted', () => {
  const dir = fixture({ 'root/main.crv': 'x\n', 'root/inside.crv': 'Inside.\n' })
  const resolve = fileSystemResolver(path.join(dir, 'root'))
  // Absolute AND inside the root: only the default-deny can reject this one,
  // so it isolates that guard from containment.
  const result = resolve(path.join(dir, 'root/inside.crv'), CTX)
  assert.equal(result.ok, false)
  assert.equal(result.ok === false && result.denial, 'absolute-denied')
})

test('an absolute path inside the root resolves once allowAbsolute is set', () => {
  const dir = fixture({ 'root/inside.crv': 'Inside.\n' })
  const resolve = fileSystemResolver(path.join(dir, 'root'), { allowAbsolute: true })
  const result = resolve(path.join(dir, 'root/inside.crv'), CTX)
  assert.equal(result.ok, true)
})

// ---------------------------------------------------------------------------
// MUST 4: never fetch a remote URL without an explicit allowlist
// ---------------------------------------------------------------------------

test('a remote URL is denied with no allowlist configured, and never touches the disk', () => {
  const dir = fixture({ 'main.crv': 'x\n' })
  const resolve = fileSystemResolver(dir)
  for (const url of [
    'https://example.com/evil.crv',
    'http://example.com/evil.crv',
    'file://localhost/etc/passwd',
    '//example.com/evil.crv',
  ]) {
    const result = resolve(url, CTX)
    assert.equal(result.ok, false, url)
    assert.equal(result.ok === false && result.denial, 'remote-not-allowed', url)
  }
})

test('a remote URL is denied even when its host IS allowlisted, because nothing fetches', () => {
  const dir = fixture({ 'main.crv': 'x\n' })
  const resolve = fileSystemResolver(dir, { allowedRemoteHosts: ['example.com'] })
  const result = resolve('https://example.com/ok.crv', CTX)
  assert.equal(result.ok, false)
  assert.equal(result.ok === false && result.denial, 'remote-not-allowed')
})

test('a URL-shaped path is not read off disk as a relative path', () => {
  // Without the scheme check a URL falls through to path joining, and
  // `<root>/https:/example.com/evil.crv` is a file an attacker can plant.
  const dir = fixture({
    'https:/example.com/evil.crv': 'PLANTED\n',
  })
  const resolve = fileSystemResolver(dir)
  const result = resolve('https://example.com/evil.crv', CTX)
  assert.equal(result.ok, false)
  assert.equal(result.ok === false && result.denial, 'remote-not-allowed')
})

// ---------------------------------------------------------------------------
// Ordinary resolution and non-file targets
// ---------------------------------------------------------------------------

test('a missing target is reported as not-found, not as a containment denial', () => {
  const dir = fixture({ 'main.crv': 'x\n' })
  const resolve = fileSystemResolver(dir)
  const result = resolve('absent.crv', CTX)
  assert.equal(result.ok, false)
  assert.equal(result.ok === false && result.denial, 'not-found')
})

test('a directory is not a document', () => {
  const dir = fixture({ 'sub/child.crv': 'x\n' })
  const resolve = fileSystemResolver(dir)
  const result = resolve('sub', CTX)
  assert.equal(result.ok, false)
  assert.equal(result.ok === false && result.denial, 'not-a-file')
})

test('bytes are counted as encoded UTF-8, not as JavaScript characters', () => {
  const dir = fixture({ 'child.crv': 'éé\u{1f600}' })
  const resolve = fileSystemResolver(dir)
  const result = resolve('child.crv', CTX)
  assert.equal(result.ok, true)
  assert.equal(result.ok === true && result.bytes, Buffer.byteLength('éé\u{1f600}', 'utf8'))
})

test('a nested relative include resolves against its parent directory, not the root', () => {
  const dir = fixture({
    'chapters/ch1.crv': 'Chapter one.\n',
    'chapters/notes.crv': 'Notes.\n',
  })
  const resolve = fileSystemResolver(dir)
  const result = resolve('notes.crv', {
    stack: [path.join(dir, 'chapters/ch1.crv')],
    depth: 1,
  })
  assert.equal(result.ok, true)
  assert.equal(result.ok === true && result.source, 'Notes.\n')
})
