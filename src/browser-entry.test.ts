import test from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { dirname, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

// Packages the browser entry may reach: the engine and the transport-free protocol helpers.
const BROWSER_SAFE = new Set(['@markup-carve/carve', 'vscode-languageserver-types', 'vscode-languageserver-textdocument'])

function importGraph(entry: string): { modules: string[]; external: string[] } {
  const seen = new Set<string>()
  const external = new Set<string>()
  const walk = (file: string): void => {
    if (seen.has(file)) return
    seen.add(file)
    const source = readFileSync(file, 'utf8')
    for (const match of source.matchAll(/(?:import|export)\s[^'"]*?from\s*['"]([^'"]+)['"]|import\(\s*['"]([^'"]+)['"]\s*\)/g)) {
      const specifier = match[1] ?? match[2]!
      if (specifier.startsWith('.')) walk(resolve(dirname(file), specifier))
      else external.add(specifier)
    }
  }
  walk(entry)
  return { modules: [...seen], external: [...external].sort() }
}

const entry = resolve(dirname(fileURLToPath(import.meta.url)), 'browser.js')

test('the browser entry reaches no Node.js built-in and no language-server transport', () => {
  const { modules, external } = importGraph(entry)
  assert.ok(modules.length > 10, `walked ${modules.length} modules`)
  assert.deepEqual(external.filter((specifier) => !BROWSER_SAFE.has(specifier)), [])
})

test('the browser entry analyzes, completes and continues lists without include options', async () => {
  const browser = await import('./browser.js')
  const analysis = browser.analyzeCarve('# Title\n\nSee [^missing].\n')
  assert.ok(analysis.symbols.length > 0)
  assert.ok(analysis.diagnostics.length > 0, 'the dead footnote reference is reported')
  assert.ok(browser.completionAt('::: ', { line: 0, character: 4 }).length > 0, 'admonition kinds complete')
  assert.deepEqual(browser.listContinuationEdits('1. a\n', { line: 1, character: 0 })?.map((edit) => edit.newText), ['2. '])
})

test('the portable include paths name a child the way the Node ones do for plain paths', async () => {
  const { portableIncludePaths } = await import('./include-paths.js')
  const { nodeIncludePaths } = await import('./node-include-paths.js')
  for (const file of ['/root/docs/a.crv', '/root/docs/sub/b c.crv', '/root/docs/a#b.crv', '/root/docs/c?d.crv', '/root/docs/50%.crv', '/root/docs/ä ö.crv']) {
    assert.equal(portableIncludePaths.toUri(file), nodeIncludePaths.toUri(file))
    assert.equal(portableIncludePaths.basename(file), nodeIncludePaths.basename(file))
    assert.equal(portableIncludePaths.relativeToRoot(file, '/root/docs'), nodeIncludePaths.relativeToRoot(file, '/root/docs'))
  }
  assert.equal(portableIncludePaths.relativeToRoot('/root/other/a.crv', '/root/docs'), '/root/other/a.crv')
  assert.equal(portableIncludePaths.relativeToRoot('/root/docs..foo/a.crv', '/root/docs'), '/root/docs..foo/a.crv')
})
