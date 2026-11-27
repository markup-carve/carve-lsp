import assert from 'node:assert/strict'
import { execFileSync } from 'node:child_process'
import { copyFileSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'
import { fileURLToPath } from 'node:url'

const repoRoot = fileURLToPath(new URL('../', import.meta.url))

function fixture(examples: object[]) {
  const root = mkdtempSync(join(tmpdir(), 'examples-through-server-'))
  mkdirSync(join(root, 'tools'))
  mkdirSync(join(root, 'dist'))
  copyFileSync(join(repoRoot, 'tools', 'examples-through-server.mjs'), join(root, 'tools', 'examples-through-server.mjs'))
  writeFileSync(join(root, 'package.json'), '{"type":"module"}')
  writeFileSync(join(root, 'examples.json'), JSON.stringify({ examples }))
  writeFileSync(join(root, 'dist', 'analyze.js'), `export function analyzeCarve(input) {
    if (input === 'throw') throw new Error('fixture failure')
    return { diagnostics: input === 'warn' ? [1] : [] }
  }
`)
  writeFileSync(join(root, 'dist', 'semantic.js'), `export function semanticTokens(input) {
    return input === 'token' ? [1, 2] : []
  }
`)
  return root
}

function run(root: string, flags: string[] = []) {
  try {
    return { status: 0, output: execFileSync(process.execPath, [join(root, 'tools', 'examples-through-server.mjs'), join(root, 'examples.json'), ...flags], { encoding: 'utf8' }) }
  } catch (error) {
    const failed = error as { status?: number; stdout?: string }
    return { status: failed.status, output: failed.stdout ?? '' }
  }
}

test('the 0.2 runner writes per-ID counts and throw rows for drift comparison', () => {
  const root = fixture([
    { id: 'first', input: 'token' },
    { id: 'second', input: 'warn' },
    { id: 'third', input: 'throw' },
  ])
  try {
    const manifest = join(root, 'manifest.tsv')
    const result = run(root, ['--manifest', manifest, '--allow-throws'])
    assert.equal(result.status, 0)
    assert.match(result.output, /^documents=3$/m)
    assert.match(result.output, /^threw=1$/m)
    assert.match(result.output, /^tokens=2$/m)
    assert.match(result.output, /^diagnostics=1$/m)
    assert.equal(readFileSync(manifest, 'utf8'), 'first\t2\t0\nsecond\t0\t1\nthird\tthrew\tthrew\n')
    assert.equal(run(root).status, 1)
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
})

test('the 0.2 runner rejects duplicate IDs before writing a manifest', () => {
  const root = fixture([{ id: 'same', input: 'token' }, { id: 'same', input: 'warn' }])
  try {
    const result = run(root, ['--manifest', join(root, 'manifest.tsv')])
    assert.equal(result.status, 1)
    assert.match(result.output, /duplicate example id/)
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
})

test('engine drift uses 0.2 examples in both comparison runs', () => {
  const workflow = readFileSync(join(repoRoot, '.github', 'workflows', 'engine-drift.yml'), 'utf8')
  assert.equal((workflow.match(/node tools\/examples-through-server\.mjs carve-main\/spec\/0\.2\/conformance\/examples\.json --manifest/g) ?? []).length, 2)
  assert.match(workflow, /node tools\/verify-example-population\.mjs carve-main/)
  assert.doesNotMatch(workflow, /node tools\/corpus-through-server\.mjs/)
})

test('the population check rejects truncated or inputless 0.2 example sets', () => {
  const root = mkdtempSync(join(tmpdir(), 'example-population-'))
  const spec = join(repoRoot, 'tests', 'spec')
  try {
    mkdirSync(join(root, 'scripts', 'lib'), { recursive: true })
    mkdirSync(join(root, 'spec', '0.2', 'conformance'), { recursive: true })
    copyFileSync(join(spec, 'scripts', 'lib', 'spec2-examples.mjs'), join(root, 'scripts', 'lib', 'spec2-examples.mjs'))
    for (const name of ['syntax-blocks', 'syntax-inline', 'ast', 'html', 'writer', 'source-layout', 'includes', 'extensions', 'import-html', 'tooling']) {
      copyFileSync(join(spec, 'spec', '0.2', `${name}.md`), join(root, 'spec', '0.2', `${name}.md`))
    }
    const data = JSON.parse(readFileSync(join(spec, 'spec', '0.2', 'conformance', 'examples.json'), 'utf8'))
    const examplesPath = join(root, 'spec', '0.2', 'conformance', 'examples.json')
    const verify = () => {
      try {
        execFileSync(process.execPath, [join(repoRoot, 'tools', 'verify-example-population.mjs'), root], { encoding: 'utf8' })
        return 0
      } catch (error) {
        return (error as { status?: number }).status ?? -1
      }
    }
    data.examples.pop()
    writeFileSync(examplesPath, JSON.stringify(data))
    assert.equal(verify(), 1)
    data.examples = JSON.parse(readFileSync(join(spec, 'spec', '0.2', 'conformance', 'examples.json'), 'utf8')).examples
    delete data.examples[0].input
    writeFileSync(examplesPath, JSON.stringify(data))
    assert.equal(verify(), 1)
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
})
