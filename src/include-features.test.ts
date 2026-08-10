import assert from 'node:assert/strict'
import test from 'node:test'
import { mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, statSync, symlinkSync, utimesSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { pathToFileURL } from 'node:url'
import { analyzeCarve } from './analyze.js'
import { DependencyIndex, watcherFor } from './dependencies.js'
import { definitionAt } from './definition.js'
import { IncludeSourceCache } from './include-cache.js'
import { fileSystemResolver } from './include-path.js'
import { parse, resolve } from '@markup-carve/carve'
import { IncludeParseCache } from './include-cache.js'

function fixture(): string {
  const dir = realpathSync(mkdtempSync(path.join(tmpdir(), 'carve-lsp-features-')))
  test.after(() => rmSync(dir, { recursive: true, force: true }))
  return dir
}

test('include cache is metadata-validated and LRU-bounded', () => {
  const cache = new IncludeSourceCache(2)
  cache.set('/a', 1, 1, { source: 'a', bytes: 1 })
  cache.set('/b', 1, 1, { source: 'b', bytes: 1 })
  assert.equal(cache.get('/a', 1, 1)?.source, 'a')
  cache.set('/c', 1, 1, { source: 'c', bytes: 1 })
  assert.equal(cache.get('/b', 1, 1), undefined)
  assert.equal(cache.get('/a', 2, 1), undefined)
  assert.equal(cache.size, 1)
})

test('parsed-child cache is version-validated', () => {
  const cache = new IncludeParseCache()
  const document = resolve(parse('# Cached\n'))
  cache.set('/child', '1:9', document)
  assert.equal(cache.get('/child', '1:9'), document)
  assert.equal(cache.get('/child', '2:9'), undefined)
})

test('filesystem cache invalidates after an included file changes', () => {
  const dir = fixture()
  const child = path.join(dir, 'child.crv')
  writeFileSync(child, '# Before\n')
  const cache = new IncludeSourceCache()
  const resolver = fileSystemResolver(dir, { cache })
  const context = { stack: [path.join(dir, 'main.crv')], depth: 0 }
  const first = resolver('child.crv', context)
  assert.match(first.ok ? first.source : '', /Before/)
  const prior = statSync(child).mtimeMs
  writeFileSync(child, '# After!\n')
  utimesSync(child, new Date(), new Date(prior + 1000))
  const next = resolver('child.crv', context)
  assert.equal(next.ok && next.source, '# After!\n')
})

test('missing contained targets expose an absolute watch candidate', () => {
  const dir = fixture()
  const result = fileSystemResolver(dir)('later.crv', {
    stack: [path.join(dir, 'main.crv')],
    depth: 0,
  })
  assert.equal(result.ok, false)
  assert.equal(result.ok ? undefined : result.watch, path.join(dir, 'later.crv'))
})

test('same missing spelling in different child directories produces two watchers', () => {
  const dir = fixture()
  mkdirSync(path.join(dir, 'a'))
  mkdirSync(path.join(dir, 'b'))
  writeFileSync(path.join(dir, 'a', 'chapter.crv'), '{{ missing.crv }}\n')
  writeFileSync(path.join(dir, 'b', 'chapter.crv'), '{{ missing.crv }}\n')
  const analysis = analyzeCarve('{{ a/chapter.crv }}\n{{ b/chapter.crv }}\n', {
    includes: {
      resolver: fileSystemResolver(dir),
      sourcePath: path.join(dir, 'main.crv'),
      includeRoot: dir,
    },
  })
  const missing = analysis.dependencies.filter((dependency) => !dependency.resolved)
  assert.deepEqual(
    missing.map((dependency) => dependency.watch).sort(),
    [path.join(dir, 'a', 'missing.crv'), path.join(dir, 'b', 'missing.crv')],
  )
})

test('a missing target below an escaping symlink is never watched', () => {
  const dir = fixture()
  const outside = fixture()
  mkdirSync(path.join(dir, 'inside'))
  symlinkSync(outside, path.join(dir, 'inside', 'escape'))
  const result = fileSystemResolver(dir)('inside/escape/later.crv', {
    stack: [path.join(dir, 'main.crv')],
    depth: 0,
  })
  assert.equal(result.ok, false)
  assert.equal(result.ok ? undefined : result.denial, 'outside-root')
  assert.equal(result.ok ? undefined : result.watch, undefined)
})

test('dependency index tracks reverse edges and meaningful watch-set changes', () => {
  const index = new DependencyIndex()
  assert.equal(index.update('file:///a', ['/child', '/missing']), true)
  assert.equal(index.update('file:///a', ['/missing', '/child']), false)
  index.update('file:///b', ['/child'])
  assert.deepEqual(index.documentsFor('/child').sort(), ['file:///a', 'file:///b'])
  assert.equal(index.remove('file:///a'), true)
  assert.deepEqual(index.watchedPaths(), ['/child'])
})

test('watchers for missing directory trees root at an existing ancestor', () => {
  const dir = fixture()
  const watcher = watcherFor(path.join(dir, 'future', 'chapter.crv'))
  assert.equal(watcher.globPattern.baseUri, pathToFileURL(dir).toString())
  assert.equal(watcher.globPattern.pattern, 'future/chapter.crv')
})

test('go-to-definition on an include uses the guarded resolver', () => {
  const dir = fixture()
  const main = path.join(dir, 'main.crv')
  const child = path.join(dir, 'child.crv')
  writeFileSync(main, '{{ child.crv }}\n')
  writeFileSync(child, '# Child\n')
  const source = readFileSync(main, 'utf8')
  const location = definitionAt(pathToFileURL(main).toString(), source, { line: 0, character: 5 }, {
    resolver: fileSystemResolver(dir),
    sourcePath: main,
    includeRoot: dir,
  })
  assert.equal(location?.uri, pathToFileURL(child).toString())
})

test('included headings contribute symbols attributed to the child file', () => {
  const dir = fixture()
  const main = path.join(dir, 'main.crv')
  const child = path.join(dir, 'child.crv')
  writeFileSync(child, '# Child heading\n')
  const analysis = analyzeCarve('{{ child.crv }}\n', {
    includes: {
      resolver: fileSystemResolver(dir),
      sourcePath: main,
      includeRoot: dir,
    },
  })
  assert.equal(analysis.includedSymbols[0]?.name, 'Child heading')
  assert.equal(analysis.includedSymbols[0]?.location.uri, pathToFileURL(child).toString())
})
