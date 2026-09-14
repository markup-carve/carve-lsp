import assert from 'node:assert/strict'
import test from 'node:test'
import { mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, symlinkSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { fileSystemResolver, type IncludeContext, type IncludeResolver } from './include-path.js'
import { resolveIncludes } from './includes.js'

const KIND = ['activation', 'filesystem', 'remote', 'graph'] as const
type Kind = (typeof KIND)[number]

interface Vector {
  name: string
  requirement: string
  kind: Kind
  entry?: string
  files?: Record<string, string>
  tree?: Record<string, string | { symlink: string }>
  root?: string
  from?: string
  request?: string
  trusted?: boolean
  enabled?: boolean
  allowAbsolute?: boolean
  allowedRemoteHosts?: string[]
  maxDepth?: number
  maxBytes?: number
  maxResolverCalls?: number
  expected: Record<string, unknown>
}

/**
 * Every member this adapter knows how to honor.
 *
 * A vector member the adapter does not read is the failure this list exists to
 * stop, and it is not hypothetical: `maxResolverCalls` arrived with carve#1990,
 * was never passed to the walk, and the two vectors carrying it therefore ran
 * under the adapter's own default of 1000 - resolving every directive and
 * recording calls the vector did not expect. An ignored limit is silent, so the
 * corpus has to be read as a contract rather than as a bag of fields.
 *
 * `trusted` is read by the corpus author, not here: the activation vector
 * states both the trust it describes and the `enabled` the host derives from
 * it, and this adapter drives the latter.
 */
const KNOWN_VECTOR_KEYS: ReadonlySet<string> = new Set([
  'name', 'description', 'requirement', 'kind',
  'entry', 'files', 'tree', 'root', 'from', 'request',
  'trusted', 'enabled', 'allowAbsolute', 'allowedRemoteHosts',
  'maxDepth', 'maxBytes', 'maxResolverCalls',
  'expected',
])

/**
 * The requirement ids this adapter answers. Pinned as a SET rather than
 * counted, so a corpus that grows a new requirement names the one that is
 * unanswered instead of only reporting that the total moved.
 */
const PINNED_REQUIREMENTS = [
  'S1-opt-in',
  'S2-contained-paths',
  'S3-remote-allowlist',
  'S4-depth-bound',
  'S5-byte-bound',
  'S6-post-budget-no-read',
  'S7-call-bound',
  'S8-post-call-bound-no-read',
]

/**
 * Warning rule ids that are a §19 whole-walk refusal, mapped to the corpus's
 * portable denial class. The corpus cannot observe warning wording, so the
 * class plus the absence of a resolver call are the two observables; the rule
 * ids on the left are this server's own and never leave it.
 */
const DENIAL_BY_RULE: Record<string, string> = {
  'include-depth': 'depth',
  'include-budget': 'budget',
  'include-call-limit': 'resolver-calls',
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
    maxResolverCalls: vector.maxResolverCalls,
  })
  // The FIRST whole-walk refusal, which is the one that latched: every later
  // directive reports the same rule without being resolved. An
  // `include-unresolved` warning is not a refusal and must not read as one -
  // the call-bound vectors are built entirely out of unresolvable targets.
  const warning = result.warnings.find((item) => item.rule in DENIAL_BY_RULE)
  return {
    resolverCalls: calls,
    maxVisitedDepth,
    chargedBytes: result.bytes,
    status: warning ? 'denied' : 'allowed',
    denial: warning === undefined ? undefined : DENIAL_BY_RULE[warning.rule],
  }
}

function run(vector: Vector): Record<string, unknown> {
  // An unknown kind used to fall through to the filesystem branch, which would
  // materialize no tree, resolve an empty request and answer `denied` - a pass,
  // for a vector nothing had implemented.
  if (!KIND.includes(vector.kind)) throw new Error(`unknown vector kind: ${String(vector.kind)}`)

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

test('pins the corpus version', () => {
  assert.equal(corpus.version, 1)
})

test('pins the vector count, so an addition cannot be skipped unnoticed', () => {
  assert.equal(corpus.vectors.length, 14)
})

test('answers every requirement the corpus states', () => {
  const stated = [...new Set(corpus.vectors.map((vector) => vector.requirement))].sort()
  assert.deepEqual(stated, [...PINNED_REQUIREMENTS].sort())
})

test('reads every member the corpus puts on a vector', () => {
  const unread = [...new Set(corpus.vectors.flatMap((vector) => Object.keys(vector)))]
    .filter((key) => !KNOWN_VECTOR_KEYS.has(key))
    .sort()
  assert.deepEqual(unread, [])
})

/**
 * One test per (vector, expected field), so a failure names the observable that
 * moved rather than the first one checked. The call-bound vectors fail three
 * different ways depending on what an adapter got wrong - an extra
 * `resolverCalls` entry, a `budget` denial where `resolver-calls` belongs, a
 * `chargedBytes` that never engaged - and collapsing them into one assertion
 * hides two of the three.
 */
const observed = new Map<string, Record<string, unknown>>()

function actualFor(vector: Vector): Record<string, unknown> {
  const cached = observed.get(vector.name)
  if (cached !== undefined) return cached
  const value = run(vector)
  observed.set(vector.name, value)
  return value
}

for (const vector of corpus.vectors) {
  for (const [field, expected] of Object.entries(vector.expected)) {
    test(`${vector.requirement} ${vector.name}: ${field}`, () => {
      assert.deepEqual(actualFor(vector)[field], expected)
    })
  }
}
