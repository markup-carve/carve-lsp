import assert from 'node:assert/strict'
import { execFileSync } from 'node:child_process'
import { mkdirSync, mkdtempSync, rmSync, writeFileSync, copyFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'
import { fileURLToPath } from 'node:url'

const repoRoot = fileURLToPath(new URL('../', import.meta.url))

// The script counted throwing documents and exited 0, so the CI step running it
// bare was green whatever `threw=` said. These rows hold the exit status rather
// than the printed count, because the status is what the step reads.
const THROW_MARKER = 'TEST_ONLY_THROWING_DOCUMENT'

/** A tree the population guard accepts: N documents and N declared pairs (or the given page). */
function fixture(documentCount: number, throwing: number, page?: string) {
  const root = mkdtempSync(join(tmpdir(), 'corpus-through-server-'))
  const corpus = join(root, 'tests', 'corpus')
  const examples = join(root, 'resources', 'examples')
  mkdirSync(corpus, { recursive: true })
  mkdirSync(examples, { recursive: true })
  mkdirSync(join(root, 'tools'), { recursive: true })
  mkdirSync(join(root, 'dist'), { recursive: true })

  for (let i = 0; i < documentCount; i += 1) {
    const body = i < throwing ? THROW_MARKER : `document ${i}`
    writeFileSync(join(corpus, `doc-${i}.crv`), `${body}\n`)
  }
  const block = ':::  compare\n```carve\nhello\n```\n```html\n<p>hello</p>\n```\n:::\n'
  writeFileSync(join(examples, 'core.md'), page ?? block.repeat(documentCount))
  writeFileSync(join(examples, 'extensions.md'), '')
  writeFileSync(join(examples, 'edge-cases.md'), '')

  copyFileSync(join(repoRoot, 'tools', 'corpus-through-server.mjs'), join(root, 'tools', 'corpus-through-server.mjs'))
  writeFileSync(
    join(root, 'dist', 'analyze.js'),
    `export function analyzeCarve(source) {\n` +
      `  if (source.includes('${THROW_MARKER}')) throw new Error('fixture failure')\n` +
      `  return { diagnostics: [] }\n}\n`,
  )
  writeFileSync(
    join(root, 'dist', 'semantic.js'),
    `export function semanticTokens(source) {\n` +
      `  if (source.includes('${THROW_MARKER}')) throw new Error('fixture failure')\n` +
      `  return []\n}\n`,
  )
  return { root, corpus }
}

function runTool(root: string, corpus: string, extra: string[] = []) {
  try {
    const stdout = execFileSync(
      process.execPath,
      [join(root, 'tools', 'corpus-through-server.mjs'), corpus, ...extra],
      { encoding: 'utf8' },
    )
    return { status: 0, stdout }
  } catch (error) {
    const failure = error as { status?: number; stdout?: string }
    return { status: failure.status ?? -1, stdout: failure.stdout ?? '' }
  }
}

test('a corpus the server reads without throwing exits 0', () => {
  const { root, corpus } = fixture(3, 0)
  try {
    const { status, stdout } = runTool(root, corpus)
    assert.match(stdout, /^threw=0$/m)
    assert.equal(status, 0)
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
})

test('a document the server throws on exits 1 and says so', () => {
  const { root, corpus } = fixture(3, 1)
  try {
    const { status, stdout } = runTool(root, corpus)
    assert.match(stdout, /^threw=1$/m)
    assert.match(stdout, /::error::the server threw on 1 of 3 corpus documents/)
    assert.equal(status, 1)
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
})

test('--allow-throws keeps the measurement and drops the exit', () => {
  const { root, corpus } = fixture(3, 1)
  try {
    const { status, stdout } = runTool(root, corpus, ['--allow-throws'])
    assert.match(stdout, /^threw=1$/m)
    assert.equal(status, 0)
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
})

test('a short corpus still fails before measuring, for its own reason', () => {
  const { root, corpus } = fixture(3, 0)
  try {
    rmSync(join(corpus, 'doc-2.crv'))
    const { status, stdout } = runTool(root, corpus)
    assert.doesNotMatch(stdout, /^threw=/m)
    assert.equal(status, 1)
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
})

test('every carve fence in a compare block is a declared pair, a nested one is not', () => {
  const pair = (n: number) => '```carve\n' + n + '\n```\n```html\n<p>' + n + '</p>\n```\n'
  const nested = '````carve\n```carve\nnot a pair\n```\n````\n```html\n<p>x</p>\n```\n'
  const page = '::: compare\n' + pair(1) + nested + pair(3) + ':::\n'
  const { root, corpus } = fixture(3, 0, page)
  try {
    const { status, stdout } = runTool(root, corpus)
    assert.match(stdout, /^documents=3$/m)
    assert.equal(status, 0)
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
})
