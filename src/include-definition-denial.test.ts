import assert from 'node:assert/strict'
import test from 'node:test'
import { mkdtempSync, writeFileSync, symlinkSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { pathToFileURL } from 'node:url'
import { definitionAt } from './definition.js'
import { includeDefinitionAt } from './include-definition.js'
import { fileSystemResolver } from './include-path.js'

/*
 * THE DENIAL HALF of include go-to-definition.
 *
 * `include-features.test.ts` covers the resolvable case - a directive whose
 * target exists inside the root navigates to it. What no test covered is the
 * other branch: a target the resolver REFUSES must not navigate at all.
 *
 * That branch is the whole security value of routing navigation through
 * `include-path.ts` rather than joining the path locally. Without it,
 * go-to-definition is a way around the containment PART 9 section 19 puts on
 * include resolution: the editor opens a file the include pass would not read.
 *
 * It was verified to be uncovered before these were written. Replacing
 * `if (!resolved.ok) return null` in include-definition.ts with a best-effort
 * location left the whole suite green at 224 of 224 - a guard that cannot fail.
 * Each test below fails under that mutation.
 */

function workspace(): { root: string; doc: string; child: string } {
  const root = mkdtempSync(path.join(tmpdir(), 'carve-lsp-incdef-'))
  const child = path.join(root, 'chapter-1.crv')
  writeFileSync(child, '# Chapter One\n')
  return { root, doc: path.join(root, 'book.crv'), child }
}

const optionsFor = (root: string, sourcePath: string) => ({
  resolver: fileSystemResolver(root, {}),
  includeRoot: root,
  sourcePath,
})

test('a target outside the root does not navigate', () => {
  const { root, doc } = workspace()
  writeFileSync(path.join(path.dirname(root), 'outside.crv'), 'secret\n')
  const at = includeDefinitionAt('{{ ../outside.crv }}\n', { line: 0, character: 4 }, optionsFor(root, doc))
  assert.equal(at, null)
})

test('a symlink escaping the root does not navigate', () => {
  const { root, doc } = workspace()
  const outsideDir = mkdtempSync(path.join(tmpdir(), 'carve-lsp-outside-'))
  const secret = path.join(outsideDir, 'secret.crv')
  writeFileSync(secret, 'secret\n')
  symlinkSync(secret, path.join(root, 'link.crv'))
  const at = includeDefinitionAt('{{ link.crv }}\n', { line: 0, character: 4 }, optionsFor(root, doc))
  assert.equal(at, null)
})

test('an absolute path does not navigate while absolutes are denied', () => {
  const { root, doc, child } = workspace()
  const at = includeDefinitionAt(`{{ ${child} }}\n`, { line: 0, character: 4 }, optionsFor(root, doc))
  assert.equal(at, null)
})

test('a missing target does not navigate', () => {
  const { root, doc } = workspace()
  const at = includeDefinitionAt('{{ nope.crv }}\n', { line: 0, character: 4 }, optionsFor(root, doc))
  assert.equal(at, null)
})

/*
 * Three properties around the branch rather than inside it. The first two are
 * NOT killed by the denial mutation above - they are controls for different
 * mistakes, and are labelled as such rather than presented as proof of the
 * guard.
 */

test('with no resolver the include branch is inert (control)', () => {
  const { root, doc } = workspace()
  const uri = pathToFileURL(doc).toString()
  assert.equal(includeDefinitionAt('{{ chapter-1.crv }}\n', { line: 0, character: 4 }, {}), null)
  assert.equal(definitionAt(uri, '{{ chapter-1.crv }}\n', { line: 0, character: 4 }), null)
  assert.ok(root)
})

test('a directive inside verbatim content is not a directive (control)', () => {
  const { root, doc } = workspace()
  const at = includeDefinitionAt('`{{ chapter-1.crv }}`\n', { line: 0, character: 6 }, optionsFor(root, doc))
  assert.equal(at, null)
})

test('a CRLF document resolves the same offsets as LF', () => {
  const { root, doc, child } = workspace()
  const at = includeDefinitionAt('a\r\nb\r\n{{ chapter-1.crv }}\r\n', { line: 2, character: 5 }, optionsFor(root, doc))
  assert.equal(at?.uri, pathToFileURL(child).toString())
})
