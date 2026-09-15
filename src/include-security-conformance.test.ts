import assert from 'node:assert/strict'
import test from 'node:test'
import { mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, symlinkSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { fileSystemResolver, type IncludeContext, type IncludeResolver } from './include-path.js'
import { readIncludeSettings } from './include-settings.js'
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
  rootSpec?: string
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
 *
 * `root` and `rootSpec` are not two spellings of one member: see
 * {@link filesystemRoot}. Two of the three `rootSpec` vectors PASSED unread,
 * because `root` defaults to the directory they happen to name - so this list,
 * not a red assertion, is what caught them.
 */
const KNOWN_VECTOR_KEYS: ReadonlySet<string> = new Set([
  'name', 'description', 'requirement', 'kind',
  'entry', 'files', 'tree', 'root', 'rootSpec', 'from', 'request',
  'trusted', 'enabled', 'allowAbsolute', 'allowedRemoteHosts',
  'maxDepth', 'maxBytes', 'maxResolverCalls',
  'expected',
])

/**
 * Every field an `expected` block may carry. The corpus README makes an
 * unknown one an adapter failure, and without this it is only ever compared
 * against `undefined` by the per-field test below - a red that names the
 * vector rather than the observable nobody implemented.
 */
const KNOWN_EXPECTED_KEYS: ReadonlySet<string> = new Set([
  'status', 'denial', 'canonicalId', 'resolverCalls', 'remoteFetches',
  'maxVisitedDepth', 'chargedBytes',
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
  'S9-root-configuration',
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

/**
 * Every portable denial class the corpus asserts, pinned as a SET so a new one
 * names itself here instead of surfacing as one vector's mismatched string.
 *
 * Two of these sit on the far side of the split carve-lsp#193 drew, where a
 * published diagnostic code may be finer than the cross-engine
 * `IncludeWarning.rule`, which stays `include-unresolved` for every refusal:
 *
 * - `not-found` is this server's resolver class already, and deliberately has
 *   NO diagnostic code of its own: a target that is merely missing IS
 *   unresolved, which is what keeps `include-denied` meaning something.
 * - `no-root` never reaches a resolver. A configured value that names no root
 *   leaves `includeOptionsFor` with no resolver to build, and `resolveIncludes`
 *   is inert without one - no directive is recognized, so nothing is resolved
 *   and nothing is reported. It is therefore not an `IncludeDenial` and gets no
 *   entry in the mapping either.
 *
 * Neither moves the rule id, which is what lets carve-lsp#187 join the denial
 * back once the engine owns the walk.
 */
const PINNED_DENIAL_CLASSES = [
  'budget',
  'depth',
  'no-root',
  'not-found',
  'outside-root',
  'remote-not-allowed',
  'resolver-calls',
]

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

/** `<ABS:path>` denotes the temporary tree's absolute path to `path`. */
function materialize(value: string, dir: string): string {
  return value.replace(/^<ABS:([^>]+)>$/, (_match, rel: string) => path.join(dir, rel))
}

/**
 * The containment root for a `filesystem` vector, and the two ways a vector
 * may name one. They are not interchangeable, and the corpus schema now
 * refuses both on one vector.
 *
 * `root` is the ADAPTER's: materialized and canonicalized here, so containment
 * is the only question left.
 *
 * `rootSpec` is the HOST's configured value, and what this server's own
 * configuration reader materializes it to is the behavior under test. So it is
 * passed through UNCHANGED - expanding `<ABS:>` is the corpus spelling out its
 * temporary tree, not a canonicalization - and the answer comes back from
 * {@link readIncludeSettings}, which is where carve-lsp#195 put the validation.
 * Canonicalizing it here first would answer the vector with the adapter's own
 * `realpathSync` and pin nothing: `realpathSync('')` is the process working
 * directory, which is the one root §19 forbids by name.
 */
function filesystemRoot(vector: Vector, dir: string): { root: string } | { root?: undefined } {
  if (vector.root !== undefined && vector.rootSpec !== undefined) {
    throw new Error(`vector names a root two ways: ${vector.name}`)
  }
  if (vector.rootSpec === undefined) {
    return { root: realpathSync(path.join(dir, vector.root ?? 'root')) }
  }
  const spec = materialize(vector.rootSpec, dir)
  const configured = readIncludeSettings({ carve: { includes: { includeRoot: spec } } }).includeRoot
  return configured === undefined ? {} : { root: configured }
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
  const { root } = filesystemRoot(vector, dir)
  // No root, no resolver, and an inert include pass behind it: the target is
  // not resolved even though it exists and sits inside the root the vector
  // INTENDED. `resolverCalls` is the observable that separates this from a
  // resolver that looked and refused.
  if (root === undefined) return { status: 'denied', denial: 'no-root', resolverCalls: [] }

  const resolver = fileSystemResolver(root, {
    allowAbsolute: vector.allowAbsolute,
    allowedRemoteHosts: vector.allowedRemoteHosts,
  })
  const request = materialize(vector.request ?? '', dir)
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
  assert.equal(corpus.vectors.length, 19)
})

test('answers every requirement the corpus states', () => {
  const stated = [...new Set(corpus.vectors.map((vector) => vector.requirement))].sort()
  assert.deepEqual(stated, [...PINNED_REQUIREMENTS].sort())
})

test('answers every denial class the corpus asserts', () => {
  const stated = [...new Set(corpus.vectors.flatMap((vector) =>
    typeof vector.expected['denial'] === 'string' ? [vector.expected['denial']] : []))].sort()
  assert.deepEqual(stated, [...PINNED_DENIAL_CLASSES].sort())
})

test('produces every observable the corpus expects', () => {
  const unknown = [...new Set(corpus.vectors.flatMap((vector) => Object.keys(vector.expected)))]
    .filter((key) => !KNOWN_EXPECTED_KEYS.has(key))
    .sort()
  assert.deepEqual(unknown, [])
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
