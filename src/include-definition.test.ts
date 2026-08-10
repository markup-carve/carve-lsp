import assert from 'node:assert/strict'
import test from 'node:test'
import { mkdtempSync, mkdirSync, writeFileSync, symlinkSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { pathToFileURL } from 'node:url'
import { definitionAt } from './definition.js'
import { includeDefinitionAt } from './include-definition.js'
import { fileSystemResolver } from './include-path.js'

function workspace(): { root: string; child: string } {
  const root = mkdtempSync(path.join(tmpdir(), 'carve-lsp-incdef-'))
  const child = path.join(root, 'chapter-1.crv')
  writeFileSync(child, '# Chapter One\n')
  return { root, child }
}

function optionsFor(root: string, sourcePath: string) {
  return { resolver: fileSystemResolver(root, {}), includeRoot: root, sourcePath }
}

test('include go-to-definition resolves a directive to the child file', () => {
  const { root, child } = workspace()
  const doc = path.join(root, 'book.crv')
  const source = 'before\n\n{{ chapter-1.crv }}\n'
  const loc = includeDefinitionAt(source, { line: 2, character: 5 }, optionsFor(root, doc))
  assert.ok(loc, 'expected a location')
  assert.equal(loc.uri, pathToFileURL(child).toString())
  assert.deepEqual(loc.range.start, { line: 0, character: 0 })
})

test('the cursor anywhere inside the directive answers, outside it does not', () => {
  const { root } = workspace()
  const doc = path.join(root, 'book.crv')
  const source = 'x {{ chapter-1.crv }} y\n'
  const opts = optionsFor(root, doc)
  // `{{` starts at character 2 and the closing `}}` ends at 21.
  for (const character of [2, 10, 20]) {
    assert.ok(includeDefinitionAt(source, { line: 0, character }, opts), `inside at ${character}`)
  }
  for (const character of [0, 1, 21, 22]) {
    assert.equal(includeDefinitionAt(source, { line: 0, character }, opts), null, `outside at ${character}`)
  }
})

test('with no resolver the include branch is inert', () => {
  const { root } = workspace()
  const source = '{{ chapter-1.crv }}\n'
  assert.equal(includeDefinitionAt(source, { line: 0, character: 4 }, {}), null)
  // And so is the whole provider, which must not throw for want of options.
  assert.equal(definitionAt(pathToFileURL(path.join(root, 'b.crv')).toString(), source, { line: 0, character: 4 }), null)
})

/*
 * THE SECURITY-CRITICAL HALF. Navigation must never open a file the resolver
 * refuses, or go-to-definition becomes a way around the containment rule that
 * PART 9 section 19 puts on include resolution. Each case below is a target the
 * resolver denies, and the answer has to be null rather than a best-effort
 * location.
 */
test('a target outside the root does not navigate', () => {
  const { root } = workspace()
  const doc = path.join(root, 'book.crv')
  const outside = path.join(path.dirname(root), 'outside.crv')
  writeFileSync(outside, 'secret\n')
  const source = '{{ ../outside.crv }}\n'
  assert.equal(includeDefinitionAt(source, { line: 0, character: 4 }, optionsFor(root, doc)), null)
})

test('a symlink escaping the root does not navigate', () => {
  const { root } = workspace()
  const doc = path.join(root, 'book.crv')
  const outsideDir = mkdtempSync(path.join(tmpdir(), 'carve-lsp-outside-'))
  const secret = path.join(outsideDir, 'secret.crv')
  writeFileSync(secret, 'secret\n')
  symlinkSync(secret, path.join(root, 'link.crv'))
  const source = '{{ link.crv }}\n'
  assert.equal(includeDefinitionAt(source, { line: 0, character: 4 }, optionsFor(root, doc)), null)
})

test('an absolute path does not navigate by default', () => {
  const { root, child } = workspace()
  const doc = path.join(root, 'book.crv')
  const source = `{{ ${child} }}\n`
  assert.equal(includeDefinitionAt(source, { line: 0, character: 4 }, optionsFor(root, doc)), null)
})

test('a missing target does not navigate', () => {
  const { root } = workspace()
  const doc = path.join(root, 'book.crv')
  const source = '{{ nope.crv }}\n'
  assert.equal(includeDefinitionAt(source, { line: 0, character: 4 }, optionsFor(root, doc)), null)
})

test('a directive inside verbatim content is not a directive', () => {
  const { root } = workspace()
  const doc = path.join(root, 'book.crv')
  const source = '`{{ chapter-1.crv }}`\n'
  assert.equal(includeDefinitionAt(source, { line: 0, character: 6 }, optionsFor(root, doc)), null)
})

test('CRLF input resolves the same offsets as LF', () => {
  const { root, child } = workspace()
  const doc = path.join(root, 'book.crv')
  const crlf = 'a\r\nb\r\n{{ chapter-1.crv }}\r\n'
  const loc = includeDefinitionAt(crlf, { line: 2, character: 5 }, optionsFor(root, doc))
  assert.ok(loc, 'CRLF document should resolve')
  assert.equal(loc.uri, pathToFileURL(child).toString())
})

test('definitionAt routes an include through without shadowing other constructs', () => {
  const { root, child } = workspace()
  const doc = path.join(root, 'book.crv')
  const uri = pathToFileURL(doc).toString()
  const opts = optionsFor(root, doc)
  const source = '{{ chapter-1.crv }}\n\ntext[^a]\n\n[^a]: note\n'
  const inc = definitionAt(uri, source, { line: 0, character: 4 }, opts)
  assert.equal(inc?.uri, pathToFileURL(child).toString())
  // The footnote still resolves inside the SAME document, so the early include
  // branch has not swallowed the constructs after it.
  const fn = definitionAt(uri, source, { line: 2, character: 5 }, opts)
  assert.equal(fn?.uri, uri)
  assert.equal(fn?.range.start.line, 4)
})
