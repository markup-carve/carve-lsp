import assert from 'node:assert/strict'
import test from 'node:test'
import { resolveIncludes } from './includes.js'
import type { IncludeResolver } from './include-path.js'

/*
 * The four §19 degradations that only exist once the child is MERGED into the
 * parent. None of them is decidable from the graph: a heading level clamps
 * against the shift the parent asked for, an id or a footnote label collides
 * with what the parent already claimed, and block content is only wrong
 * because of the position the directive sits in.
 *
 * The server walked the graph and could report none of them. Delegating to the
 * engine's expansion pass is what makes them reachable, so each one is pinned
 * here at the seam this server publishes from.
 */

function virtualResolver(files: Record<string, string>): IncludeResolver {
  return (includePath) => {
    const source = files[includePath]
    if (source === undefined) return { ok: false, id: includePath, denial: 'not-found' }
    return { ok: true, id: includePath, source, bytes: Buffer.byteLength(source, 'utf8') }
  }
}

const rules = (warnings: { rule: string }[]) => warnings.map((warning) => warning.rule)

// --- a heading shifted past level 6 --------------------------------------

test('a heading shifted past level 6 is reported as clamped', () => {
  const result = resolveIncludes('{{ a @shift:+3 }}', {
    resolver: virtualResolver({ a: '##### Deep\n' }),
  })
  assert.deepEqual(rules(result.warnings), ['include-heading-clamp'])
})

test('the clamp names the level it asked for and the level it got', () => {
  const result = resolveIncludes('{{ a @shift:+3 }}', {
    resolver: virtualResolver({ a: '##### Deep\n' }),
  })
  assert.match(result.warnings[0]?.message ?? '', /8 was clamped to 6/)
})

test('a shift that stays inside the range clamps nothing', () => {
  const result = resolveIncludes('{{ a @shift:+1 }}', {
    resolver: virtualResolver({ a: '##### Deep\n' }),
  })
  assert.deepEqual(result.warnings, [])
})

test('a clamp is attributed to the child, and anchored on the root directive', () => {
  const source = 'Lead.\n\n{{ a @shift:+3 }}\n'
  const result = resolveIncludes(source, {
    resolver: virtualResolver({ a: '##### Deep\n' }),
    sourcePath: '/root.crv',
  })
  const warning = result.warnings[0]
  assert.equal(warning?.file, 'a')
  assert.equal(warning?.start, source.indexOf('{{ a @shift:+3 }}'))
})

test('a clamp carries the position inside the child it happened in', () => {
  const result = resolveIncludes('{{ a @shift:+3 }}', {
    resolver: virtualResolver({ a: 'Intro.\n\n##### Deep\n' }),
    sourcePath: '/root.crv',
  })
  assert.equal(result.warnings[0]?.within?.line, 3)
})

// --- a heading id the parent already claimed ------------------------------

test('an id the parent already claimed is reported as renamed', () => {
  const result = resolveIncludes('{#intro}\n# Parent\n\n{{ a }}\n', {
    resolver: virtualResolver({ a: '{#intro}\n# Child\n' }),
  })
  assert.deepEqual(rules(result.warnings), ['include-heading-id-rename'])
})

test('the rename names both the taken id and the one it was given', () => {
  const result = resolveIncludes('{#intro}\n# Parent\n\n{{ a }}\n', {
    resolver: virtualResolver({ a: '{#intro}\n# Child\n' }),
  })
  assert.match(result.warnings[0]?.message ?? '', /"intro" was renamed to "intro-2"/)
})

test('an id nothing else claims is left alone', () => {
  const result = resolveIncludes('{#intro}\n# Parent\n\n{{ a }}\n', {
    resolver: virtualResolver({ a: '{#body}\n# Child\n' }),
  })
  assert.deepEqual(result.warnings, [])
})

// --- a footnote label the parent already defined --------------------------

test('a footnote label the parent already defined is reported as renamed', () => {
  const result = resolveIncludes('Parent[^a].\n\n[^a]: Parent note.\n\n{{ a }}\n', {
    resolver: virtualResolver({ a: 'Child[^a].\n\n[^a]: Child note.\n' }),
  })
  assert.deepEqual(rules(result.warnings), ['include-footnote-rename'])
})

test('a footnote rename is attributed to the child that carried the label', () => {
  const result = resolveIncludes('Parent[^a].\n\n[^a]: Parent note.\n\n{{ a }}\n', {
    resolver: virtualResolver({ a: 'Child[^a].\n\n[^a]: Child note.\n' }),
    sourcePath: '/root.crv',
  })
  assert.equal(result.warnings[0]?.file, 'a')
})

test('a label nothing else defines is left alone', () => {
  const result = resolveIncludes('Parent[^a].\n\n[^a]: Parent note.\n\n{{ a }}\n', {
    resolver: virtualResolver({ a: 'Child[^b].\n\n[^b]: Child note.\n' }),
  })
  assert.deepEqual(result.warnings, [])
})

// --- block content at an inline position ----------------------------------

test('an inline directive resolving to block content is reported', () => {
  const result = resolveIncludes('See {{ a }} here.\n', {
    resolver: virtualResolver({ a: '# Heading\n\nBody.\n' }),
  })
  assert.deepEqual(rules(result.warnings), ['include-block-in-inline'])
})

test('an inline directive resolving to one paragraph is silent', () => {
  const result = resolveIncludes('See {{ a }} here.\n', {
    resolver: virtualResolver({ a: 'just a phrase\n' }),
  })
  assert.deepEqual(result.warnings, [])
})

test('the same block child at a BLOCK position is fine', () => {
  // The directive is what moved, not the child: block content is only wrong
  // because of where it was asked for.
  const result = resolveIncludes('{{ a }}\n', {
    resolver: virtualResolver({ a: '# Heading\n\nBody.\n' }),
  })
  assert.deepEqual(result.warnings, [])
})

test('a block-in-inline warning is anchored on the directive, not the sentence', () => {
  const source = 'See {{ a }} here.\n'
  const result = resolveIncludes(source, {
    resolver: virtualResolver({ a: '# Heading\n\nBody.\n' }),
  })
  assert.equal(result.warnings[0]?.start, source.indexOf('{{ a }}'))
  assert.equal(result.warnings[0]?.end, source.indexOf('{{ a }}') + '{{ a }}'.length)
})

// --- read, then rejected ---------------------------------------------------
//
// A target is READ before most of §19's refusals can be decided, so "the
// resolver produced source" is not the same question as "the content is in the
// document". Only the second one may feed the outline or a seam location.

test('a child rejected for a missing section contributes no document', () => {
  const result = resolveIncludes('{{ a #Gamma }}', {
    resolver: virtualResolver({ a: '# Alpha\n\nText.\n' }),
  })
  assert.deepEqual(result.dependencies, [{ id: 'a', resolved: true }])
  assert.deepEqual(result.documents, [])
})

test('a child rejected for a line range past its end contributes no document', () => {
  const result = resolveIncludes('{{ a @lines:40-50 }}', {
    resolver: virtualResolver({ a: '# Alpha\n' }),
  })
  assert.deepEqual(result.documents, [])
})

test('a child that IS merged still contributes its document', () => {
  // The negative control: the filter must not be an unconditional empty list.
  const result = resolveIncludes('{{ a }}', {
    resolver: virtualResolver({ a: '# Alpha\n' }),
  })
  assert.deepEqual(
    result.documents.map((document) => document.id),
    ['a'],
  )
})

test('a grandchild merged through its parent contributes its own document', () => {
  const result = resolveIncludes('{{ a }}', {
    resolver: virtualResolver({ a: '# Alpha\n\n{{ b }}\n', b: '## Beta\n' }),
  })
  assert.deepEqual(
    result.documents.map((document) => document.id).sort(),
    ['a', 'b'],
  )
})

test('a child whose only content is a footnote definition still contributes a document', () => {
  // Its blocks are empty once the definition has moved into the parent, so the
  // only §19 source stamp it leaves is on the footnote body.
  const result = resolveIncludes('Parent[^x].\n\n{{ a }}\n', {
    resolver: virtualResolver({ a: '[^x]: Note.\n' }),
  })
  assert.deepEqual(
    result.documents.map((document) => document.id),
    ['a'],
  )
})

// --- the same target written twice ----------------------------------------

test('each occurrence of a repeated include carries its own diagnostic', () => {
  // The engine expands the target once per occurrence and raises the warning
  // each time, but reports only the file it arose in. Anchoring both at the
  // first directive would leave the second with no diagnostic at all, on a
  // document where it has exactly the same problem.
  const source = 'Lead.\n\n{{ a }}\n\nMiddle.\n\n{{ a }}\n'
  const result = resolveIncludes(source, {
    resolver: virtualResolver({ a: 'Child.\n\n{{ missing }}\n' }),
    sourcePath: '/root.crv',
  })
  assert.deepEqual(
    result.warnings.map((warning) => warning.start),
    [source.indexOf('{{ a }}'), source.lastIndexOf('{{ a }}')],
  )
})

test('both occurrences still name the child the problem is in', () => {
  const result = resolveIncludes('{{ a }}\n\n{{ a }}\n', {
    resolver: virtualResolver({ a: 'Child.\n\n{{ missing }}\n' }),
    sourcePath: '/root.crv',
  })
  assert.deepEqual(
    result.warnings.map((warning) => warning.file),
    ['a', 'a'],
  )
})

// --- the byte budget charges the file that was read ------------------------

test('a CRLF child is charged the bytes it actually occupies', () => {
  // The budget bounds a size, so whatever this seam hands the engine has to be
  // as long as the file the resolver read. Collapsing `\r\n` would charge one
  // byte per line less than the file holds, and a budget of N bytes would
  // admit close to 2N of them.
  const child = 'a\r\nb\r\nc\r\n'
  const result = resolveIncludes('{{ a }}', { resolver: virtualResolver({ a: child }) })
  assert.equal(result.bytes, Buffer.byteLength(child, 'utf8'))
})

test('a carriage-return child is charged the bytes it actually occupies', () => {
  const child = 'a\rb\rc\r'
  const result = resolveIncludes('{{ a }}', { resolver: virtualResolver({ a: child }) })
  assert.equal(result.bytes, Buffer.byteLength(child, 'utf8'))
})

test('a CRLF child stays inside a budget that fits it', () => {
  const child = 'a\r\nb\r\n'
  const result = resolveIncludes('{{ a }}', {
    resolver: virtualResolver({ a: child }),
    maxBytes: Buffer.byteLength(child, 'utf8'),
  })
  assert.deepEqual(result.warnings, [])
})

test('a CRLF child overruns a budget measured on its collapsed form', () => {
  // The mutation guard for the line above: with `\r\n` collapsed this child
  // would fit, and the bound would have been quietly widened.
  const child = 'a\r\nb\r\n'
  const result = resolveIncludes('{{ a }}', {
    resolver: virtualResolver({ a: child }),
    maxBytes: Buffer.byteLength(child.replace(/\r\n/g, '\n'), 'utf8'),
  })
  assert.deepEqual(
    result.warnings.map((warning) => warning.rule),
    ['include-budget'],
  )
})
