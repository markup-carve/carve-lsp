import assert from 'node:assert/strict'
import test from 'node:test'
import { resolveIncludes } from './includes.js'
import { lineCount, sectionRange, sections } from './include-selection.js'
import type { IncludeResolver } from './include-path.js'

/*
 * The SELECTION half of include diagnostics.
 *
 * A directive can name a section the child does not have, a line range that
 * starts past its end, or both selections at once. None of the three needs the
 * merge - they are decidable from the child's own source - and all three were
 * silently accepted here while the reference engine warned on them
 * (`include-selection-conflict`, `include-section`,
 * `include-lines-out-of-range` in markup-carve/carve-js).
 */

function virtualResolver(files: Record<string, string>, reads?: string[]): IncludeResolver {
  return (includePath) => {
    reads?.push(includePath)
    const source = files[includePath]
    if (source === undefined) return { ok: false, id: includePath, denial: 'not-found' }
    return { ok: true, id: includePath, source, bytes: Buffer.byteLength(source, 'utf8') }
  }
}

const CHILD = '# Alpha\n\nText.\n\n## Beta\n'
const rules = (warnings: { rule: string }[]) => warnings.map((warning) => warning.rule)

// --- both selections at once ---------------------------------------------

test('a directive using both a section and a line range is refused', () => {
  const result = resolveIncludes('{{ a #Alpha @lines:1-2 }}', {
    resolver: virtualResolver({ a: CHILD }),
  })
  assert.deepEqual(rules(result.warnings), ['include-selection-conflict'])
})

test('a conflicting selection is refused BEFORE the target is read', () => {
  const reads: string[] = []
  resolveIncludes('{{ a #Alpha @lines:1-2 }}', {
    resolver: virtualResolver({ a: CHILD }, reads),
  })
  assert.deepEqual(reads, [])
})

test('a conflicting selection anchors on the directive it was written at', () => {
  const result = resolveIncludes('Lead.\n\n{{ a #Alpha @lines:1-2 }}\n', {
    resolver: virtualResolver({ a: CHILD }),
  })
  assert.equal(result.warnings[0]?.line, 3)
})

// --- a section the child does not declare --------------------------------

test('a section the child does not declare is reported', () => {
  const result = resolveIncludes('{{ a #Gamma }}', { resolver: virtualResolver({ a: CHILD }) })
  assert.deepEqual(rules(result.warnings), ['include-section'])
})

test('the missing-section message names the section that was asked for', () => {
  const result = resolveIncludes('{{ a #Gamma }}', { resolver: virtualResolver({ a: CHILD }) })
  assert.match(result.warnings[0]?.message ?? '', /#Gamma/)
})

test('a section the child DOES declare is silent', () => {
  const result = resolveIncludes('{{ a #Beta }}', { resolver: virtualResolver({ a: CHILD }) })
  assert.deepEqual(result.warnings, [])
})

test('an auto-slugged section counts as declared', () => {
  const result = resolveIncludes('{{ a #Alpha }}', { resolver: virtualResolver({ a: CHILD }) })
  assert.deepEqual(result.warnings, [])
})

test('the target stays a RESOLVED dependency when its section is missing', () => {
  const result = resolveIncludes('{{ a #Gamma }}', { resolver: virtualResolver({ a: CHILD }) })
  assert.deepEqual(result.dependencies, [{ id: 'a', resolved: true }])
})

test('a section that only a grandchild would supply is still missing', () => {
  // Selection happens BEFORE the child's own includes are expanded, so a
  // section cannot arrive through a grandchild: it has to be declared in the
  // file the directive names. The grandchild is never resolved either, which
  // is the point - content outside the wanted section must not be read.
  const reads: string[] = []
  const result = resolveIncludes('{{ a #Gamma }}', {
    resolver: virtualResolver({ a: '# Alpha\n\n{{ b }}\n', b: '## Gamma\n' }, reads),
  })
  assert.deepEqual(rules(result.warnings), ['include-section'])
  assert.deepEqual(reads, ['a'])
})

// --- a line range past the end -------------------------------------------

test('a line range starting past the end of the child is reported', () => {
  const result = resolveIncludes('{{ a @lines:40-50 }}', { resolver: virtualResolver({ a: CHILD }) })
  assert.deepEqual(rules(result.warnings), ['include-lines-out-of-range'])
})

test('a line range inside the child is silent', () => {
  const result = resolveIncludes('{{ a @lines:1-3 }}', { resolver: virtualResolver({ a: CHILD }) })
  assert.deepEqual(result.warnings, [])
})

test('the last line of the child is in range', () => {
  const result = resolveIncludes('{{ a @lines:5-5 }}', { resolver: virtualResolver({ a: CHILD }) })
  assert.deepEqual(result.warnings, [])
})

// --- the primitives underneath -------------------------------------------

test('a trailing newline does not open a further line', () => {
  assert.equal(lineCount('# Alpha\n'), 1)
})

test('line counting normalizes CRLF', () => {
  assert.equal(lineCount('a\r\nb\r\n'), 2)
})

test('sections carry every heading the resolver gives an id', () => {
  assert.deepEqual(
    sections(CHILD).map((section) => section.id),
    ['Alpha', 'Beta'],
  )
})

test('an explicit heading id wins over its slug', () => {
  // Carve puts the attribute block on its OWN line above the heading; a
  // trailing block on the heading line is not an attribute block here.
  assert.ok(sectionRange('{#chosen}\n# Alpha\n', 'chosen'))
})

test('an explicitly identified heading is not ALSO found under its slug', () => {
  assert.equal(sectionRange('{#chosen}\n# Alpha\n', 'Alpha'), undefined)
})

test('a section that is not there has no range', () => {
  assert.equal(sectionRange(CHILD, 'Gamma'), undefined)
})

test('an empty child has no lines to select', () => {
  assert.equal(lineCount(''), 0)
})

test('a line range against an empty child is out of range', () => {
  const result = resolveIncludes('{{ a @lines:1-1 }}', { resolver: virtualResolver({ a: '' }) })
  assert.deepEqual(rules(result.warnings), ['include-lines-out-of-range'])
})
