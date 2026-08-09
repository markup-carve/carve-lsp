import assert from 'node:assert/strict'
import test from 'node:test'
import { mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, symlinkSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { fileSystemResolver, type IncludeContext, type IncludeResolver } from './include-path.js'
import { resolveIncludes } from './includes.js'

interface Vector {
  name: string
  kind: 'activation' | 'filesystem' | 'remote' | 'graph'
  entry?: string
  files?: Record<string, string>
  tree?: Record<string, string | { symlink: string }>
  root?: string
  from?: string
  request?: string
  enabled?: boolean
  allowAbsolute?: boolean
  allowedRemoteHosts?: string[]
  maxDepth?: number
  maxBytes?: number
  expected: Record<string, unknown>
}

const sourceRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const corpusPath = path.join(sourceRoot, 'tests/spec/tests/include-security-conformance/vectors.json')
const corpus = JSON.parse(readFileSync(corpusPath, 'utf8')) as { version: number; vectors: Vector[] }

function fixture(tree: Vector['tree']): string {
  const dir = realpathSync(mkdtempSync(path.join(tmpdir(), 'carve-lsp-security-')))
  const links: Array<[string, string]> = []
  for (const [name, value] of Object.entries(tree ?? {})) {
    const full = path.join(dir, name)
    mkdirSync(path.dirname(full), { recursive: true })
    if (typeof value === 'string') writeFileSync(full, value)
    else links.push([full, value.symlink])
  }
  for (const [full, target] of links) symlinkSync(path.join(dir, target), full)
  test.after(() => rmSync(dir, { recursive: true, force: true }))
  return dir
}

function graph(vector: Vector): Record<string, unknown> {
  const calls: string[] = []
  let maxVisitedDepth = 0
  const resolver: IncludeResolver = (request, context) => {
    calls.push(request)
    maxVisitedDepth = Math.max(maxVisitedDepth, context.depth + 1)
    const source = vector.files?.[request]
    return source === undefined
      ? { ok: false, id: request, denial: 'not-found' }
      : { ok: true, id: request, source, bytes: Buffer.byteLength(source, 'utf8') }
  }
  const result = resolveIncludes(vector.entry ?? '', {
    resolver,
    maxDepth: vector.maxDepth,
    maxBytes: vector.maxBytes,
  })
  const warning = result.warnings.find((item) => item.rule === 'include-depth' || item.rule === 'include-budget')
  return {
    resolverCalls: calls,
    maxVisitedDepth,
    chargedBytes: result.bytes,
    status: warning ? 'denied' : 'allowed',
    denial: warning?.rule === 'include-depth' ? 'depth' : warning ? 'budget' : undefined,
  }
}

function run(vector: Vector): Record<string, unknown> {
  if (vector.kind === 'activation') {
    const calls: string[] = []
    const resolver: IncludeResolver = (request) => {
      calls.push(request)
      return { ok: false, id: request, denial: 'not-found' }
    }
    resolveIncludes(vector.entry ?? '', vector.enabled ? { resolver } : {})
    return { resolverCalls: calls }
  }

  if (vector.kind === 'graph') return graph(vector)

  const dir = fixture(vector.tree ?? { 'root/main.crv': '' })
  const root = realpathSync(path.join(dir, vector.root ?? 'root'))
  const resolver = fileSystemResolver(root, {
    allowAbsolute: vector.allowAbsolute,
    allowedRemoteHosts: vector.allowedRemoteHosts,
  })
  const rawRequest = vector.request ?? ''
  const request = rawRequest.replace(/^<ABS:([^>]+)>$/, (_match, rel: string) => path.join(dir, rel))
  const context: IncludeContext = vector.from
    ? { stack: [realpathSync(path.join(dir, vector.from))], depth: 0 }
    : { stack: [], depth: 0 }
  const result = resolver(request, context)

  if (vector.kind === 'remote') {
    return {
      status: result.ok ? 'allowed' : vector.allowedRemoteHosts?.length ? 'unsupported' : 'denied',
      denial: result.ok ? undefined : result.denial,
      remoteFetches: [],
    }
  }

  return result.ok
    ? { status: 'allowed', canonicalId: result.id.replace(root, '<ROOT>') }
    : { status: 'denied', denial: result.denial }
}

test('executes every shared PART 9 section 19 security vector', async (t) => {
  assert.equal(corpus.version, 1)
  assert.equal(corpus.vectors.length, 12)

  for (const vector of corpus.vectors) {
    await t.test(vector.name, () => {
      const actual = run(vector)
      for (const [field, expected] of Object.entries(vector.expected)) {
        assert.deepEqual(actual[field], expected, `${vector.name}: ${field}`)
      }
    })
  }
})
