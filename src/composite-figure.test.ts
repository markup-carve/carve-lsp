import assert from 'node:assert/strict'
import test from 'node:test'
import { parse, resolve } from '@markup-carve/carve'
import { completionAt } from './completion.js'
import { foldingRanges } from './folding.js'
import { hoverAt } from './hover.js'
import { semanticTokens } from './semantic.js'

/*
 * Composite figures across the four features that read block types (PART 9 §4c,
 * markup-carve/carve#1215).
 *
 * A BARE `::: figure` opener - the fence, its separator, the kind word, and
 * NOTHING else - is ONE figure of ordered panels, and the engine normalizes it
 * to a `figure_group` node. An opener carrying a quoted title or a `[label]` is
 * not that production at all and stays a generic container.
 *
 * Every feature here switches on `node.type` with a default that does nothing,
 * so a node type the engine grew and the server never learned is INVISIBLE
 * rather than a type error: the container simply stops folding, hovering and
 * tokenizing, and every existing test stays green. That is the failure this file
 * is here to catch, which is why the first test asserts the engine's shape
 * directly - if the dependency stops producing `figure_group`, this file should
 * say so plainly rather than reporting four unrelated feature failures.
 */

const GROUP = '::: figure\n![one](a.png)\n^ (a) One\n:::\n^ Figure #: Group caption\n'
const TITLED = '::: figure "A titled figure div"\n![one](a.png)\n^ (a) One\n:::\n'
const LABELLED = '::: figure [g]\nBody.\n:::\n'

const topLevelTypes = (source: string): string[] =>
  resolve(parse(source, { positions: true })).children.map((node) => node.type)

test('the pinned engine normalizes a bare figure fence to a figure_group', () => {
  assert.deepEqual(topLevelTypes(GROUP), ['figure_group'])
})

test('a title or a label leaves it a generic container', () => {
  // The control for every case below. These two differ from GROUP only in the
  // tail of one line, so a reading that fires on the kind word alone would
  // report them as groups and nothing else here would notice.
  assert.deepEqual(topLevelTypes(TITLED), ['admonition'])
  assert.deepEqual(topLevelTypes(LABELLED), ['admonition'])
})

test('a composite figure folds', () => {
  const ranges = foldingRanges(GROUP)
  assert.ok(
    ranges.some((range) => range.startLine === 0 && range.endLine >= 3),
    `no fold for the group: ${JSON.stringify(ranges)}`,
  )
})

test('the opener carries the reserved kind word as a type token', () => {
  const opener = semanticTokens(GROUP).filter((token) => token.line === 0)
  assert.ok(opener.length > 0, 'the opener line produced no token at all')
  assert.equal(opener[0].type, 'type')
  // `::: figure` - the whole reserved opener, not just the fence run.
  assert.equal(opener[0].character, 0)
  assert.equal(opener[0].length, 10)
})

test('the group caption after the closing fence is tokenized', () => {
  // Line 4, the `^ ` line BELOW the closer. It is the group's caption and it
  // sits outside the container, which is the one placement §4c adds: read from
  // any child instead of from the group, and this line has no token at all.
  assert.ok(
    semanticTokens(GROUP).some((token) => token.line === 4),
    'the caption line below the closing fence produced no token',
  )
})

test('hovering a composite figure describes the group, not an admonition', () => {
  const hover = hoverAt(GROUP, { line: 0, character: 4 })
  const text = typeof hover?.contents === 'object' && 'value' in hover.contents ? hover.contents.value : ''
  assert.match(text, /Composite Figure/)
})

test('a titled figure opener still hovers as an admonition', () => {
  const hover = hoverAt(TITLED, { line: 0, character: 4 })
  const text = typeof hover?.contents === 'object' && 'value' in hover.contents ? hover.contents.value : ''
  assert.match(text, /Admonition/)
})

test('a colon fence offers figure, and not as a ninth admonition kind', () => {
  const items = completionAt(':::', { line: 0, character: 3 })
  const figure = items.find((item) => item.label === 'figure')
  assert.ok(figure, `figure is not offered: ${items.map((i) => i.label).join(',')}`)
  assert.equal(figure.detail, 'Composite figure')
  // The eight are still there and still say what they are.
  const note = items.find((item) => item.label === 'note')
  assert.equal(note?.detail, 'Admonition kind')
})
