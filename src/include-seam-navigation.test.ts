import assert from 'node:assert/strict'
import test from 'node:test'
import { pathToFileURL } from 'node:url'
import { definitionAt } from './definition.js'
import type { IncludeResolved, IncludeResolver } from './include-path.js'

/*
 * Go to definition across an include seam.
 *
 * A crossref in the parent can name a heading only an included file supplies.
 * The server used to answer nothing there, because it searched the open
 * document and the open document does not contain the heading.
 *
 * Resolved through the MERGED document rather than each child's own source:
 * the id an author writes is the id the merge produced, and the merge renames
 * a child id the parent had already claimed and drops everything outside a
 * selected section. The resolver is in-memory and its ids are absolute so they
 * can become `file:` URIs; nothing here touches a disk.
 */

const files: Record<string, string> = {
  '/book/child.crv': '# Chapter Three\n\nBody text.\n',
  '/book/deep.crv': 'Lead.\n\n{{ nested.crv }}\n',
  '/book/nested.crv': 'Lead.\n\n## Deep Heading\n',
  '/book/sections.crv': '# Alpha\n\nText.\n\n# Beta\n\nMore.\n',
  '/book/claimed.crv': '{#intro}\n# Child Intro\n',
  '/book/figure.crv': 'Lead.\n\n{#plan}\n![A plan](plan.png)\n^ Figure #: The plan\n',
  '/book/padded.crv': 'pad one\n\npad two\n\npad three\n\npad four\n\n# Late Heading\n',
}

const resolver: IncludeResolver = (includePath): IncludeResolved => {
  const id = `/book/${includePath}`
  const source = files[id]
  return source === undefined
    ? { ok: false, id, denial: 'not-found' }
    : { ok: true, id, watch: id, source, bytes: Buffer.byteLength(source, 'utf8') }
}

const includes = { resolver, sourcePath: '/book/main.crv', includeRoot: '/book' }

/**
 * Go to definition on the crossref `id` written in `source`.
 *
 * `options` is passed through as given, with no default: an omitted argument
 * and an explicit `undefined` are the same value in JavaScript, so a default
 * here would silently hand the include options to the test that exists to run
 * WITHOUT them.
 */
function jump(source: string, id: string, options: typeof includes | undefined) {
  // The LAST occurrence: every fixture writes the crossref after the content,
  // and an id also appears in the `{#id}` attribute block that declares it.
  const offset = source.lastIndexOf(`#${id}`) + 1
  const line = source.slice(0, offset).split('\n').length - 1
  const character = offset - source.lastIndexOf('\n', offset - 1) - 1
  return definitionAt('file:///book/main.crv', source, { line, character }, options)
}

test('a crossref to a heading an include contributes lands in the child file', () => {
  const location = jump('# Book\n\n{{ child.crv }}\n\nSee [](#chapter-three).\n', 'chapter-three', includes)
  assert.equal(location?.uri, pathToFileURL('/book/child.crv').toString())
  assert.equal(location?.range.start.line, 0)
})

test('the angle-bracket spelling of the same crossref resolves too', () => {
  const location = jump('# Book\n\n{{ child.crv }}\n\nSee </#chapter-three>.\n', 'chapter-three', includes)
  assert.equal(location?.uri, pathToFileURL('/book/child.crv').toString())
})

test('a crossref into a sliced child lands on the heading line in the file', () => {
  // The merged node carries the child's id and the SLICE's coordinates, so an
  // untranslated jump opens `padded.crv` at its first padding paragraph.
  const location = jump(
    '{{ padded.crv @lines:9-9 }}\n\nSee [](#late-heading).\n',
    'late-heading',
    includes,
  )
  assert.equal(location?.uri, pathToFileURL('/book/padded.crv').toString())
  assert.equal(location?.range.start.line, 8)
})

test('a heading the ROOT declares still resolves in the root', () => {
  // The negative control: the seam lookup must not capture what already worked.
  const location = jump('# Book\n\n# Chapter Three\n\nSee [](#chapter-three).\n', 'chapter-three', includes)
  assert.equal(location?.uri, 'file:///book/main.crv')
  assert.equal(location?.range.start.line, 2)
})

test('with includes off the crossref resolves to nothing', () => {
  // §19 opt-in: without a resolver nothing is read, so there is no heading to
  // find and none is invented.
  assert.equal(
    jump('# Book\n\n{{ child.crv }}\n\nSee [](#chapter-three).\n', 'chapter-three', undefined),
    null,
  )
})

test('a crossref naming nothing at all still resolves to nothing', () => {
  assert.equal(
    jump('# Book\n\n{{ child.crv }}\n\nSee [](#nowhere-at-all).\n', 'nowhere-at-all', includes),
    null,
  )
})

test('a heading a GRANDCHILD contributes lands in the grandchild', () => {
  const location = jump('# Book\n\n{{ deep.crv }}\n\nSee [](#deep-heading).\n', 'deep-heading', includes)
  assert.equal(location?.uri, pathToFileURL('/book/nested.crv').toString())
  assert.equal(location?.range.start.line, 2)
})

test('a section selection drops the headings it did not select', () => {
  // The reason this reads the merged document rather than the child's file:
  // `#Alpha` contributes Alpha and not Beta, so a crossref to Beta names
  // nothing even though the file on disk declares it.
  const source = '# Book\n\n{{ sections.crv #Alpha }}\n\nSee [](#beta).\n'
  assert.equal(jump(source, 'beta', includes), null)
})

test('the section that WAS selected still resolves', () => {
  const source = '# Book\n\n{{ sections.crv #Alpha }}\n\nSee [](#alpha).\n'
  const location = jump(source, 'alpha', includes)
  assert.equal(location?.uri, pathToFileURL('/book/sections.crv').toString())
  assert.equal(location?.range.start.line, 0)
})

test('a child id the parent had already claimed resolves under its renamed id', () => {
  // The merge renames the child's `intro` to `intro-2` (§19 I5). An author
  // reading the assembled document writes the renamed id, and it has to reach
  // the heading that actually carries it.
  const source = '{#intro}\n# Book\n\n{{ claimed.crv }}\n\nSee [](#intro-2).\n'
  const location = jump(source, 'intro-2', includes)
  assert.equal(location?.uri, pathToFileURL('/book/claimed.crv').toString())
  assert.equal(location?.range.start.line, 1)
})

test('an id that merely LOOKS like a path produces no jump', () => {
  // Same rule as the diagnostic seam: the location is the resolver's `watch`,
  // not a shape test on the id. A virtual-filesystem resolver hands back an
  // absolute-looking id that no editor can open.
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
  const location = jump(
    '# Book\n\n{{ child.crv }}\n\nSee [](#chapter-three).\n',
    'chapter-three',
    { resolver: virtual, sourcePath: '/book/main.crv', includeRoot: '/book' },
  )
  assert.equal(location, null)
})

// --- captioned hosts ------------------------------------------------------
//
// A crossref reaches a figure, a table or a composite panel as well as a
// heading (PART 9R R4), and reaches them in the open document already. The
// seam must not make the target model depend on which file the host sits in.

test('a crossref to a figure an include contributes lands in the child file', () => {
  const location = jump(
    '# Book\n\n{{ figure.crv }}\n\nSee [](#plan).\n',
    'plan',
    includes,
  )
  assert.equal(location?.uri, pathToFileURL('/book/figure.crv').toString())
  assert.equal(location?.range.start.line, 3)
})

test('a figure the ROOT declares still resolves in the root', () => {
  const source = '# Book\n\n{#plan}\n![A plan](plan.png)\n^ Figure #: The plan\n\nSee [](#plan).\n'
  const location = jump(source, 'plan', includes)
  assert.equal(location?.uri, 'file:///book/main.crv')
})
