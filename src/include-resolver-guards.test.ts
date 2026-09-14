import assert from 'node:assert/strict'
import test from 'node:test'
import { resolveIncludes } from './includes.js'
import type { IncludeResolver } from './include-path.js'

// The guards that sit at the RESOLVER SEAM of the PART 9 §19 walk: the bound on
// resolver invocations, the terminality of a spent whole-walk total, and a
// target that did not resolve to text.
//
// Each assertion is its own test. A suite stops at the first failing assertion
// in a test, so several per test would hide every one behind it - and the
// mutation proof for this file depends on seeing exactly which guards go.

const NUL = String.fromCharCode(0)

/** In-memory resolver, matching the conformance suite's "virtual" mode. */
function virtualResolver(files: Record<string, string>, reads?: string[]): IncludeResolver {
  return (includePath) => {
    reads?.push(includePath)
    const source = files[includePath]
    if (source === undefined) return { ok: false, id: includePath, denial: 'not-found' }
    return { ok: true, id: includePath, source, bytes: Buffer.byteLength(source, 'utf8') }
  }
}

/** A document of `n` directives, each naming a distinct target. */
function directives(n: number, name: (i: number) => string): string {
  return Array.from({ length: n }, (_, i) => `{{ ${name(i)} }}`).join('\n\n')
}

// ---------------------------------------------------------------------------
// MUST bound resolver invocations per render
//
// The byte budget cannot stand in for this bound. A target that fails to
// resolve is never charged, so a document naming files that do not exist
// resolves every one of them with the budget untouched - which is the shape
// measured on this walk before the bound existed.
// ---------------------------------------------------------------------------

test('a document of unresolvable directives stops calling the resolver at the bound', () => {
  const reads: string[] = []
  resolveIncludes(directives(50, (i) => `missing-${i}`), {
    resolver: virtualResolver({}, reads),
    maxResolverCalls: 10,
  })
  assert.equal(reads.length, 10)
})

test('the directive past the bound is never passed to the resolver', () => {
  // §19: "A directive past the bound is left literal with a Warning and MUST
  // NOT be passed to the resolver."
  const reads: string[] = []
  resolveIncludes(directives(50, (i) => `missing-${i}`), {
    resolver: virtualResolver({}, reads),
    maxResolverCalls: 10,
  })
  assert.ok(!reads.includes('missing-10'), `the 11th target was read anyway: ${reads.join(',')}`)
})

test('the bound is reported as include-call-limit', () => {
  const result = resolveIncludes(directives(50, (i) => `missing-${i}`), {
    resolver: virtualResolver({}),
    maxResolverCalls: 10,
  })
  assert.ok(result.warnings.some((w) => w.rule === 'include-call-limit'))
})

test('the byte budget alone does not bound unresolvable directives', () => {
  // The regression this guard exists for: zero bytes charged, so a budget-only
  // walk resolves every one of them.
  const reads: string[] = []
  const result = resolveIncludes(directives(40, (i) => `missing-${i}`), {
    resolver: virtualResolver({}, reads),
    maxBytes: 8,
    maxResolverCalls: 5,
  })
  assert.equal(result.bytes, 0, 'an unresolved target must charge nothing')
})

test('with the bound spent, the byte budget is still untouched', () => {
  const result = resolveIncludes(directives(40, (i) => `missing-${i}`), {
    resolver: virtualResolver({}),
    maxResolverCalls: 5,
  })
  assert.equal(result.bytes, 0)
})

test('the call bound counts resolved targets too, not only failures', () => {
  const reads: string[] = []
  resolveIncludes(directives(20, () => 'a'), {
    resolver: virtualResolver({ a: 'Body.' }, reads),
    maxResolverCalls: 6,
  })
  assert.equal(reads.length, 6)
})

test('a target refused by the bound is reported as an UNRESOLVED dependency', () => {
  // The target would resolve perfectly well; it is the bound that refused it.
  // So the entry must say unresolved - a host that re-validates on change needs
  // to come back to it - which is what distinguishes this from an unbounded
  // walk, where the same directive resolves.
  const result = resolveIncludes('{{ missing }}\n\n{{ real }}', {
    resolver: virtualResolver({ real: 'Body.' }),
    maxResolverCalls: 1,
  })
  assert.deepEqual(
    result.dependencies.find((d) => d.id === 'real'),
    { id: 'real', resolved: false },
  )
})

test('the call bound applies across the whole walk, not per document', () => {
  // Three levels, one directive each: the bound is a whole-walk total, so a
  // chain exhausts it exactly as a flat document does.
  const reads: string[] = []
  resolveIncludes('{{ a }}', {
    resolver: virtualResolver({ a: '{{ b }}', b: '{{ c }}', c: 'Bottom.' }, reads),
    maxResolverCalls: 2,
  })
  assert.deepEqual(reads, ['a', 'b'])
})

test('the default bound is 1000, the §19 recommended floor', () => {
  const reads: string[] = []
  resolveIncludes(directives(1200, (i) => `missing-${i}`), {
    resolver: virtualResolver({}, reads),
  })
  assert.equal(reads.length, 1000)
})

// ---------------------------------------------------------------------------
// Refusal is terminal
//
// §19: once the byte budget or the call bound is spent, every remaining
// directive MUST degrade "without being resolved - not resolved and then
// refused".
// ---------------------------------------------------------------------------

test('once the call bound is spent, a resolvable target is not resolved either', () => {
  const reads: string[] = []
  resolveIncludes(`${directives(3, (i) => `missing-${i}`)}\n\n{{ real }}`, {
    resolver: virtualResolver({ real: 'Body.' }, reads),
    maxResolverCalls: 3,
  })
  assert.ok(!reads.includes('real'), `a later target was resolved after refusal: ${reads.join(',')}`)
})

test('every directive after a spent budget is refused without a read', () => {
  const child = 'x'.repeat(100)
  const reads: string[] = []
  resolveIncludes('{{ a }}\n\n'.repeat(20), {
    resolver: virtualResolver({ a: child }, reads),
    maxBytes: 250,
  })
  // Two fit; the third is read and rejected by the charge that overruns the
  // budget; the remaining seventeen are never read.
  assert.equal(reads.length, 3)
})

test('a budget consumed exactly to the limit still refuses the next directive', () => {
  // The boundary the latch exists for: a charge landing ON the limit leaves no
  // room, so expansion must stop even though nothing was overrun.
  const reads: string[] = []
  resolveIncludes('{{ a }}\n\n{{ a }}', {
    resolver: virtualResolver({ a: 'xxxxx' }, reads),
    maxBytes: 5,
  })
  assert.deepEqual(reads, ['a'])
})

test('a spent call bound keeps reporting include-call-limit, not include-budget', () => {
  const result = resolveIncludes(directives(6, (i) => `missing-${i}`), {
    resolver: virtualResolver({}),
    maxResolverCalls: 2,
  })
  const rules = new Set(result.warnings.slice(2).map((w) => w.rule))
  assert.deepEqual([...rules], ['include-call-limit'])
})

test('the call-limit message names the directive that was refused', () => {
  const result = resolveIncludes(directives(3, (i) => `missing-${i}`), {
    resolver: virtualResolver({}),
    maxResolverCalls: 1,
  })
  const refused = result.warnings.find((w) => w.rule === 'include-call-limit')
  assert.ok(refused?.message.includes('missing-1'), `message was: ${refused?.message}`)
})

test('a call-limit warning is anchored in the root document', () => {
  const source = directives(3, (i) => `missing-${i}`)
  const result = resolveIncludes(source, {
    resolver: virtualResolver({}),
    maxResolverCalls: 1,
  })
  const refused = result.warnings.find((w) => w.rule === 'include-call-limit')
  assert.ok(refused && refused.end <= source.length, 'warning range escapes the root document')
})

// ---------------------------------------------------------------------------
// Text-only
//
// §19: "a binary or unreadable target is not an include" - Warning plus the
// literal directive. A binary file named `.crv` otherwise enters the walk as
// though it were source.
// ---------------------------------------------------------------------------

test('a target carrying a NUL byte is reported as non-text', () => {
  const result = resolveIncludes('{{ bin }}', {
    resolver: virtualResolver({ bin: `PK${NUL}${NUL}data` }),
  })
  assert.deepEqual(
    result.warnings.map((w) => w.rule),
    ['include-non-text'],
  )
})

test('a non-text target does not become a child document', () => {
  // `documents` feeds navigation and preview; a binary blob must not reach it.
  const result = resolveIncludes('{{ bin }}', {
    resolver: virtualResolver({ bin: `PK${NUL}data` }),
  })
  assert.deepEqual(result.documents, [])
})

test('a non-text target is charged no bytes', () => {
  const result = resolveIncludes('{{ bin }}', {
    resolver: virtualResolver({ bin: `PK${NUL}${'x'.repeat(500)}` }),
  })
  assert.equal(result.bytes, 0)
})

test('a non-text target is reported as an unresolved dependency', () => {
  // Still watchable: replacing the binary with real source must re-validate.
  const result = resolveIncludes('{{ bin }}', {
    resolver: virtualResolver({ bin: `PK${NUL}data` }),
  })
  assert.deepEqual(result.dependencies, [{ id: 'bin', resolved: false }])
})

test('a non-text target is not walked for directives of its own', () => {
  const reads: string[] = []
  resolveIncludes('{{ bin }}', {
    resolver: virtualResolver({ bin: `${NUL}{{ a }}`, a: 'Body.' }, reads),
  })
  assert.deepEqual(reads, ['bin'])
})

test('a sibling of a non-text target still resolves', () => {
  // The non-text degradation is per directive, not a whole-walk refusal.
  const result = resolveIncludes(`{{ bin }}\n\n{{ ok }}`, {
    resolver: virtualResolver({ bin: `PK${NUL}`, ok: 'Body.' }),
  })
  assert.ok(result.documents.some((d) => d.id === 'ok'))
})

test('ordinary text with no NUL is unaffected', () => {
  const result = resolveIncludes('{{ ok }}', { resolver: virtualResolver({ ok: '# Heading' }) })
  assert.deepEqual(result.warnings, [])
})
