import assert from 'node:assert/strict'
import test from 'node:test'
import { mkdtempSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { includeDefinitionAt } from './include-definition.js'
import { fileSystemResolver } from './include-path.js'

/*
 * WHERE go-to-definition lands inside the child.
 *
 * `include-definition-denial.test.ts` pins that a refused target navigates
 * nowhere. This pins the other axis: a directive that SELECTS a place must
 * land on it. The provider used to return line 0, character 0 unconditionally,
 * discarding a section and a line range it had already parsed.
 */

const CHILD = ['# Chapter One', '', 'Body text.', '', '## Later part', '', 'More.', ''].join('\n')

function workspace(): { root: string; doc: string } {
  const root = mkdtempSync(path.join(tmpdir(), 'carve-lsp-incsel-'))
  writeFileSync(path.join(root, 'chapter.crv'), CHILD)
  return { root, doc: path.join(root, 'book.crv') }
}

const optionsFor = (root: string, sourcePath: string) => ({
  resolver: fileSystemResolver(root, {}),
  includeRoot: root,
  sourcePath,
})

const cursor = { line: 0, character: 4 }

test('a plain directive lands at the top of the child', () => {
  const { root, doc } = workspace()
  const location = includeDefinitionAt('{{ chapter.crv }}', cursor, optionsFor(root, doc))
  assert.equal(location?.range.start.line, 0)
})

test('a section selection lands on that heading', () => {
  const { root, doc } = workspace()
  const location = includeDefinitionAt('{{ chapter.crv #Later-part }}', cursor, optionsFor(root, doc))
  assert.equal(location?.range.start.line, 4)
})

test('a section selection lands past the heading marker, not in column 0', () => {
  const { root, doc } = workspace()
  const location = includeDefinitionAt('{{ chapter.crv #Later-part }}', cursor, optionsFor(root, doc))
  assert.equal(location?.range.start.character, 3)
})

test('the first section is distinguished from the file start', () => {
  const { root, doc } = workspace()
  const location = includeDefinitionAt('{{ chapter.crv #Chapter-One }}', cursor, optionsFor(root, doc))
  assert.equal(location?.range.start.character, 2)
})

test('a line range lands on its first line', () => {
  const { root, doc } = workspace()
  const location = includeDefinitionAt('{{ chapter.crv @lines:3-5 }}', cursor, optionsFor(root, doc))
  assert.equal(location?.range.start.line, 2)
})

test('a section the child does not declare falls back to the top of the file', () => {
  const { root, doc } = workspace()
  const location = includeDefinitionAt('{{ chapter.crv #Nope }}', cursor, optionsFor(root, doc))
  assert.equal(location?.range.start.line, 0)
})

test('a section the child does not declare still navigates to the child', () => {
  const { root, doc } = workspace()
  const location = includeDefinitionAt('{{ chapter.crv #Nope }}', cursor, optionsFor(root, doc))
  assert.ok(location?.uri.endsWith('chapter.crv'))
})

test('a line range starting past the end of the child lands at the file start', () => {
  // Definition can be asked for independently of the diagnostic that reports
  // the bad range, so an out-of-bounds LSP position must never leave here.
  const { root, doc } = workspace()
  const location = includeDefinitionAt('{{ chapter.crv @lines:40-50 }}', cursor, optionsFor(root, doc))
  assert.equal(location?.range.start.line, 0)
})

test('the last line of the child is still a legal landing', () => {
  const { root, doc } = workspace()
  const location = includeDefinitionAt('{{ chapter.crv @lines:7-7 }}', cursor, optionsFor(root, doc))
  assert.equal(location?.range.start.line, 6)
})

const SNIPPETS = ['# Snippets', '', 'Intro.', '%% #region backup', 'Back up first.', 'Then restore.', '%% #endregion', ''].join('\n')

function regionWorkspace(): { root: string; doc: string } {
  const root = mkdtempSync(path.join(tmpdir(), 'carve-lsp-incregion-'))
  writeFileSync(path.join(root, 'snippets.crv'), SNIPPETS)
  return { root, doc: path.join(root, 'book.crv') }
}

test('a region selection lands on its first selected line, after the opening marker', () => {
  const { root, doc } = regionWorkspace()
  const location = includeDefinitionAt('{{ snippets.crv@region:backup }}', cursor, optionsFor(root, doc))
  assert.deepEqual(location?.range.start, { line: 4, character: 0 })
})

test('a region opened behind a // comment marker lands inside it for a code include', () => {
  const root = mkdtempSync(path.join(tmpdir(), 'carve-lsp-incregion-'))
  writeFileSync(path.join(root, 'demo.js'), ['const a = 1', '// #region core', 'run()', '// #endregion core', ''].join('\n'))
  const location = includeDefinitionAt('{{ demo.js @region:core @code }}', cursor, optionsFor(root, path.join(root, 'book.crv')))
  assert.equal(location?.range.start.line, 2)
})

test('a region the child does not declare falls back to the top of the file', () => {
  const { root, doc } = regionWorkspace()
  const location = includeDefinitionAt('{{ snippets.crv @region:nope }}', cursor, optionsFor(root, doc))
  assert.equal(location?.range.start.line, 0)
  assert.ok(location?.uri.endsWith('snippets.crv'))
})
