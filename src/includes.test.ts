import assert from 'node:assert/strict'
import test from 'node:test'
import { resolveIncludes } from './includes.js'
import type { IncludeResolver } from './include-path.js'

// The graph-level half of PART 9 §19: recursion depth and total expanded byte
// size. Expectations follow the cross-engine include-conformance vectors
// `i03-*`, `i06-*` and `i11-*` in markup-carve/carve, which currently live only
// on the unmerged spec branch for markup-carve/carve#291.

/** In-memory resolver, matching the conformance suite's "virtual" mode. */
function virtualResolver(files: Record<string, string>, reads?: string[]): IncludeResolver {
  return (includePath) => {
    reads?.push(includePath)
    const source = files[includePath]
    if (source === undefined) return { ok: false, id: includePath, denial: 'not-found' }
    return { ok: true, id: includePath, source, bytes: Buffer.byteLength(source, 'utf8') }
  }
}

// ---------------------------------------------------------------------------
// Opt-in: the pass is inert until a host hands over a resolver
// ---------------------------------------------------------------------------

test('with no resolver the directive stays literal, with no warning and no dependency (i03-no-resolver-literal)', () => {
  const result = resolveIncludes('See {{ child.crv }} here.')
  assert.deepEqual(result.warnings, [])
  assert.deepEqual(result.dependencies, [])
  assert.equal(result.bytes, 0)
})

test('with no resolver a resolvable-looking target is still not reported (i03-no-deps-without-resolver)', () => {
  const reads: string[] = []
  const result = resolveIncludes('{{ child }}', { sourcePath: '/doc.crv' })
  assert.deepEqual(result.dependencies, [])
  assert.deepEqual(reads, [])
})

// ---------------------------------------------------------------------------
// MUST 5: bound recursion depth
// ---------------------------------------------------------------------------

test('recursion stops at the depth limit and the unreached target is never read (i06-depth-limit)', () => {
  const reads: string[] = []
  const result = resolveIncludes('{{ a }}', {
    resolver: virtualResolver({ a: '{{ b }}', b: 'Deep.' }, reads),
    maxDepth: 1,
  })
  assert.deepEqual(
    result.warnings.map((w) => ({ rule: w.rule, file: w.file })),
    [{ rule: 'include-depth', file: 'a' }],
  )
  assert.deepEqual(result.dependencies, [
    { id: 'a', resolved: true },
    { id: 'b', resolved: false },
  ])
  // The point of the bound: `b` is reported so a host can watch it, and is
  // never handed to the resolver.
  assert.deepEqual(reads, ['a'])
})

test('a deep chain is bounded rather than followed to its end', () => {
  const files: Record<string, string> = {}
  for (let i = 0; i < 40; i += 1) files[`f${i}`] = `{{ f${i + 1} }}`
  files['f40'] = 'Bottom.'
  const reads: string[] = []
  const result = resolveIncludes('{{ f0 }}', {
    resolver: virtualResolver(files, reads),
    maxDepth: 4,
  })
  assert.deepEqual(reads, ['f0', 'f1', 'f2', 'f3'])
  assert.deepEqual(
    result.warnings.map((w) => w.rule),
    ['include-depth'],
  )
})

// ---------------------------------------------------------------------------
// MUST 6: bound total expanded byte size
// ---------------------------------------------------------------------------

test('the byte budget stops expansion with a warning (i06-budget-limit)', () => {
  const result = resolveIncludes('{{ a }}', {
    resolver: virtualResolver({ a: 'too large' }),
    maxBytes: 1,
  })
  assert.deepEqual(
    result.warnings.map((w) => w.rule),
    ['include-budget'],
  )
  assert.deepEqual(result.dependencies, [{ id: 'a', resolved: true }])
})

test('the budget is charged per occurrence, so repeated includes amplify against it', () => {
  // The include-bomb shape: one small file pulled in many times. A budget
  // charged per DISTINCT file would let this through unbounded.
  const child = 'x'.repeat(100)
  const source = '{{ a }}\n\n'.repeat(20)
  const reads: string[] = []
  const result = resolveIncludes(source, {
    resolver: virtualResolver({ a: child }, reads),
    maxBytes: 250,
  })
  // Two occurrences fit inside 250 bytes. The third is read and then rejected
  // by the charge that takes the total past the budget; the remaining
  // seventeen are rejected before the resolver is called at all, so the
  // exhausted budget stops the reads as well as the expansion.
  assert.equal(reads.length, 3)
  assert.equal(result.bytes, 300)
  assert.equal(result.warnings.filter((w) => w.rule === 'include-budget').length, 18)
})

test('a transitive fan-out is stopped by the budget', () => {
  // a includes b twice, b includes c twice, and so on: 2^n growth from a
  // handful of small files, which is the amplification the MUST names.
  const files: Record<string, string> = {
    a: '{{ b }}\n\n{{ b }}',
    b: '{{ c }}\n\n{{ c }}',
    c: '{{ d }}\n\n{{ d }}',
    d: 'x'.repeat(200),
  }
  const result = resolveIncludes('{{ a }}', {
    resolver: virtualResolver(files),
    maxBytes: 600,
  })
  assert.ok(result.warnings.some((w) => w.rule === 'include-budget'))
})

// ---------------------------------------------------------------------------
// Cycles and dependency reporting
// ---------------------------------------------------------------------------

test('a two-file cycle is caught and attributed to the file that closed it (i06-cycle-two-file)', () => {
  const result = resolveIncludes('{{ a }}', {
    resolver: virtualResolver({ a: '{{ b }}', b: '{{ a }}' }),
  })
  assert.deepEqual(
    result.warnings.map((w) => ({ rule: w.rule, file: w.file })),
    [{ rule: 'include-cycle', file: 'b' }],
  )
  assert.deepEqual(result.dependencies, [
    { id: 'a', resolved: true },
    { id: 'b', resolved: true },
  ])
})

test('a self-cycle is caught (i06-self-cycle)', () => {
  const result = resolveIncludes('{{ a }}', { resolver: virtualResolver({ a: '{{ a }}' }) })
  assert.deepEqual(
    result.warnings.map((w) => w.rule),
    ['include-cycle'],
  )
})

test('cycle detection uses the recursion stack, so a diamond is not mistaken for a cycle', () => {
  // a -> b -> d and a -> c -> d. `d` appears twice but never inside itself.
  const result = resolveIncludes('{{ a }}', {
    resolver: virtualResolver({ a: '{{ b }}\n\n{{ c }}', b: '{{ d }}', c: '{{ d }}', d: 'Leaf.' }),
  })
  assert.deepEqual(result.warnings, [])
  assert.deepEqual(
    result.dependencies.map((d) => d.id),
    ['a', 'b', 'd', 'c'],
  )
})

test('the same target twice is one dependency (i11-same-file-twice-once)', () => {
  const result = resolveIncludes('{{ child }}\n\n{{ child }}', {
    resolver: virtualResolver({ child: 'Body.' }),
  })
  assert.deepEqual(result.dependencies, [{ id: 'child', resolved: true }])
})

test('a missing target is reported as an unresolved dependency (i11-missing-target-unresolved-dep)', () => {
  const result = resolveIncludes('{{ present }}\n\n{{ absent }}', {
    resolver: virtualResolver({ present: 'Here.' }),
  })
  assert.deepEqual(
    result.warnings.map((w) => w.rule),
    ['include-unresolved'],
  )
  assert.deepEqual(result.dependencies, [
    { id: 'present', resolved: true },
    { id: 'absent', resolved: false },
  ])
})

test('a resolver that throws yields a warning whose message carries no raw error text (i07-resolver-throws-no-leak)', () => {
  const result = resolveIncludes('{{ a }}', {
    resolver: () => {
      throw new Error('ENOENT: open /home/someone/secret/a')
    },
  })
  const [warning] = result.warnings
  assert.ok(warning)
  assert.equal(warning.rule, 'include-unresolved')
  assert.ok(!warning.message.includes('/home/someone'))
  // The raw text is kept out of `message` but available for a log sink.
  assert.ok(warning.detail?.includes('/home/someone'))
})

test('a warning carries the directive range and a 1-based line and column', () => {
  const source = 'intro\n\n{{ absent }}\n'
  const result = resolveIncludes(source, { resolver: virtualResolver({}) })
  const [warning] = result.warnings
  assert.ok(warning)
  assert.equal(warning.start, source.indexOf('{{ absent }}'))
  assert.equal(warning.end, source.indexOf('{{ absent }}') + '{{ absent }}'.length)
  assert.equal(warning.line, 3)
  assert.equal(warning.column, 1)
})

test('a nested warning is anchored on the top-level directive of the open document', () => {
  const source = 'intro\n\n{{ a }}\n'
  const result = resolveIncludes(source, {
    resolver: virtualResolver({ a: 'child text\n\n{{ absent }}' }),
  })
  const [warning] = result.warnings
  assert.ok(warning)
  // The range must be valid in the document the client has open, and `file`
  // says where the problem actually is.
  assert.equal(warning.start, source.indexOf('{{ a }}'))
  assert.equal(warning.file, 'a')
})

test('an unknown option warns and resolves nothing (i01-unknown-option-literal)', () => {
  const reads: string[] = []
  const result = resolveIncludes('{{ child @nope:1 }}', {
    resolver: virtualResolver({ child: 'text' }, reads),
  })
  assert.deepEqual(
    result.warnings.map((w) => w.rule),
    ['include-unknown-option'],
  )
  assert.deepEqual(result.dependencies, [])
  assert.deepEqual(reads, [])
})

test('a directive inside a fence is not resolved even with a resolver active (i09-verbatim-fence-and-code-span)', () => {
  const reads: string[] = []
  const result = resolveIncludes('```txt\n{{ child }}\n```\n\nUse `{{ child }}`.', {
    resolver: virtualResolver({ child: 'expanded' }, reads),
  })
  assert.deepEqual(result.warnings, [])
  assert.deepEqual(result.dependencies, [])
  assert.deepEqual(reads, [])
})
