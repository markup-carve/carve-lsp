import assert from 'node:assert/strict'
import test from 'node:test'
import { pathToFileURL } from 'node:url'
import { analyzeCarve } from './analyze.js'
import { resolveIncludes } from './includes.js'
import type { IncludeResolved, IncludeResolver } from './include-path.js'

/**
 * Mapping a warning back across an include seam.
 *
 * A diagnostic anchored at the parent for a problem that lives in a child sends
 * the author to edit the wrong file, so the position inside the child is pinned
 * here rather than left to a reader of the message prose. The root anchor stays
 * what it was: it is the only range valid in the document the client has open,
 * and `relatedInformation` is the LSP mechanism for the other end.
 *
 * The resolver is in-memory and its ids are absolute so they can become
 * `file:` URIs; nothing here touches a disk.
 */

const CHILD = '# Chapter\n\nIntro text.\n\n{{ missing.crv }}\n'
const ROOT = '# Book\n\n{{ child.crv }}\n'

/** Offset of the failing directive inside {@link CHILD}, and its span. */
const IN_CHILD = { start: 24, end: 41, line: 5, column: 1 }
/** Offset of the top-level directive inside {@link ROOT}. */
const IN_ROOT = { start: 8, end: 23 }

/** Four padding paragraphs, so a directive on line 9 is nowhere near line 1. */
const PADDING = 'pad one\n\npad two\n\npad three\n\npad four\n\n'
/** Offset of the failing directive inside `padded.crv`, in that whole file. */
const IN_PADDED = { start: 39, end: 56, line: 9, column: 1 }

const files: Record<string, string> = {
  '/book/child.crv': CHILD,
  '/book/deep.crv': '{{ nested.crv }}\n',
  '/book/nested.crv': 'text\n\n{{ missing.crv }}\n',
  // Carriage-return endings, which a `\n` scan reads as a single line.
  '/book/classic.crv': CHILD.replace(/\n/g, '\r'),
  '/book/padded.crv': `${PADDING}{{ missing.crv }}\n`,
  '/book/slicer.crv': '{{ padded.crv @lines:9-9 }}\n',
  '/book/quiet.crv': `${PADDING}quiet\n`,
}

/** Stands in for a filesystem-backed resolver: it reports a `watch` path. */
const resolver: IncludeResolver = (includePath): IncludeResolved => {
  const id = `/book/${includePath}`
  const source = files[id]
  return source === undefined
    ? { ok: false, id, denial: 'not-found' }
    : { ok: true, id, watch: id, source, bytes: Buffer.byteLength(source, 'utf8') }
}

function warningsFor(source: string) {
  return resolveIncludes(source, { resolver, sourcePath: '/book/main.crv' }).warnings
}

test('a warning raised in a child carries the span inside that child', () => {
  const warning = warningsFor(ROOT)[0]
  assert.equal(warning?.file, '/book/child.crv')
  assert.deepEqual(warning?.within, IN_CHILD)
})

test('the same warning keeps the root anchor, because that is the open document', () => {
  const warning = warningsFor(ROOT)[0]
  assert.equal(warning?.start, IN_ROOT.start)
  assert.equal(warning?.end, IN_ROOT.end)
})

test('a warning raised in the root document has no child span', () => {
  // `file` is still set - it is the root's own identity - so the absence of a
  // span is what separates "arose here" from "arose in something I pulled in".
  const warning = warningsFor('{{ missing.crv }}\n')[0]
  assert.equal(warning?.file, '/book/main.crv')
  assert.equal(warning?.within, undefined)
})

test('a grandchild reports its own position, not its parent', () => {
  // `deep.crv` includes `nested.crv`, and the failing directive is in the
  // grandchild. A `within` inherited from one frame up would read line 1.
  const warning = resolveIncludes('{{ deep.crv }}\n', {
    resolver,
    sourcePath: '/book/main.crv',
  }).warnings[0]
  assert.equal(warning?.file, '/book/nested.crv')
  assert.deepEqual(warning?.within, { start: 6, end: 23, line: 3, column: 1 })
})

test('a child pulled in by a line range reports its position in the whole file', () => {
  // The engine slices the source before parsing it, so its own reading of this
  // warning is line 1 of a one-line slice. Line 1 of `padded.crv` is a padding
  // paragraph, and that is where the author would be sent.
  const warning = warningsFor('{{ padded.crv @lines:9-9 }}\n')[0]
  assert.equal(warning?.file, '/book/padded.crv')
  assert.deepEqual(warning?.within, IN_PADDED)
})

test('a line range written in a child, not in the root, translates the same way', () => {
  // `slicer.crv` is what carries the `@lines`, so the range cannot be found by
  // looking at the root's directives.
  const warning = warningsFor('{{ slicer.crv }}\n')[0]
  assert.equal(warning?.file, '/book/padded.crv')
  assert.deepEqual(warning?.within, IN_PADDED)
})

test('a line range on one child leaves a warning from another child alone', () => {
  // `quiet.crv` is sliced and warns about nothing; `child.crv` is not sliced.
  // A translation applied to the pass rather than to the file each position was
  // measured in would move this warning by the other directive's range.
  const warning = warningsFor('{{ quiet.crv @lines:9-9 }}\n\n{{ child.crv }}\n')[0]
  assert.equal(warning?.file, '/book/child.crv')
  assert.deepEqual(warning?.within, IN_CHILD)
})

test('a child written once sliced and once whole is left where the engine put it', () => {
  // Both occurrences stamp the same canonical id and neither warning says which
  // one it came from, so one correction for the id would move the whole-file
  // occurrence to line 17 of a nine-line file. Until the engine carries that
  // identity (#224) the engine's own readings stand: line 1 measured in the
  // slice, and line 9 measured in the file.
  const lines = warningsFor('{{ padded.crv @lines:9-9 }}\n\n{{ padded.crv }}\n').map(
    (warning) => warning.within?.line,
  )
  assert.deepEqual(lines, [1, 9])
})

test('the location of a sliced child is the line the author has to open', () => {
  const diagnostic = analyzeCarve('{{ padded.crv @lines:9-9 }}\n', { includes: { resolver } })
    .diagnostics.find((entry) => entry.code === 'include-unresolved')
  assert.deepEqual(diagnostic?.relatedInformation?.[0]?.location.range, {
    start: { line: 8, character: 0 },
    end: { line: 8, character: 17 },
  })
})

test('the published diagnostic stays on the top-level directive', () => {
  const diagnostic = analyzeCarve(ROOT, { includes: { resolver } }).diagnostics
    .find((entry) => entry.code === 'include-unresolved')
  assert.deepEqual(diagnostic?.range, {
    start: { line: 2, character: 0 },
    end: { line: 2, character: 15 },
  })
})

test('the published diagnostic locates the child file it actually came from', () => {
  const diagnostic = analyzeCarve(ROOT, { includes: { resolver } }).diagnostics
    .find((entry) => entry.code === 'include-unresolved')
  assert.deepEqual(diagnostic?.relatedInformation?.[0]?.location, {
    uri: pathToFileURL('/book/child.crv').toString(),
    range: { start: { line: 4, character: 0 }, end: { line: 4, character: 17 } },
  })
})

test('the message still names the child, for a client that renders no locations', () => {
  const diagnostic = analyzeCarve(ROOT, { includes: { resolver, includeRoot: '/book' } })
    .diagnostics.find((entry) => entry.code === 'include-unresolved')
  assert.match(diagnostic?.message ?? '', /\(in child\.crv\)$/)
})

test('a warning from the open document gets no related information', () => {
  const diagnostic = analyzeCarve('{{ missing.crv }}\n', { includes: { resolver } })
    .diagnostics.find((entry) => entry.code === 'include-unresolved')
  assert.equal(diagnostic?.relatedInformation, undefined)
})

test('an id that merely LOOKS like a path produces no location', () => {
  // The near miss, and the reason the rule is the resolver's `watch` rather
  // than `path.isAbsolute`: a virtual-filesystem resolver can hand back
  // `/virtual/child.crv`, which is absolute and which no editor can open.
  // Publishing a `file:` URI for it offers the author a location that is not
  // there, which is the failure this whole change exists to prevent.
  const virtual: IncludeResolver = (includePath): IncludeResolved => {
    const source = files[`/book/${includePath}`]
    return source === undefined
      ? { ok: false, id: `/virtual/${includePath}`, denial: 'not-found' }
      : {
          ok: true,
          id: `/virtual/${includePath}`,
          source,
          bytes: Buffer.byteLength(source, 'utf8'),
        }
  }
  const diagnostic = analyzeCarve(ROOT, { includes: { resolver: virtual } }).diagnostics
    .find((entry) => entry.code === 'include-unresolved')
  assert.ok(diagnostic, 'the warning itself must still be published')
  assert.equal(diagnostic.relatedInformation, undefined)
})

test('a child written with carriage-return endings still reports a real line', () => {
  // The root's line endings are normalized before anything is measured; a
  // child's are too, so the same directive lands on line 5 whichever ending
  // the file uses. Without that, a `\n` scan sees one line and every warning
  // in the file collapses onto it.
  const warning = warningsFor('{{ classic.crv }}\n')[0]
  assert.equal(warning?.file, '/book/classic.crv')
  assert.deepEqual(warning?.within, IN_CHILD)
})

test('the location of a carriage-return child is a range a client can open', () => {
  const diagnostic = analyzeCarve('{{ classic.crv }}\n', { includes: { resolver } })
    .diagnostics.find((entry) => entry.code === 'include-unresolved')
  assert.deepEqual(diagnostic?.relatedInformation?.[0]?.location.range, {
    start: { line: 4, character: 0 },
    end: { line: 4, character: 17 },
  })
})
