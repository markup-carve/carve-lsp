import assert from 'node:assert/strict'
import test from 'node:test'
import { carveToHtml, lintCarve, parse, resolve } from '@markup-carve/carve'
import { analyzeCarve } from './analyze.js'
import { captionTargets, panelLetter } from './captions.js'
import { completionAt } from './completion.js'
import { definitionAt } from './definition.js'
import { hoverAt } from './hover.js'
import { referencesAt } from './references.js'

/*
 * A composite figure across the features that resolve an id (PART 9 §4c,
 * markup-carve/carve#1122), plus the diagnostics the clause names.
 *
 * The crossref half of this was NOT a figure_group gap. The server resolved no
 * caption id at all - not a group's, not a panel's, and not the plain captioned
 * figure's that predates the feature - because every crossref feature walked
 * headings only. The `{#fig}` figure below is here for exactly that reason: it
 * is the case that has been broken the longest and is the control for the group
 * cases, so a fix that only taught the walk about `figure_group` fails it.
 *
 * WHERE THE EXPECTED TEXT COMES FROM. The engine, not this file's reading of
 * §4c. `carveToHtml` writes the resolved text into the anchor for each id, and
 * the assertions below compare the server's answer against THAT rather than
 * against a literal - so a letter scheme or a numbering rule that changes
 * upstream fails here instead of diverging quietly in an editor.
 */

const DOC = `# Section

{#fig}
![plain](p.png)
^ Figure #: Plain

{#g}
::: figure
{#one}
![one](a.png)
^ (a) One

A stray paragraph between the panels.

{#two}
![two](b.png)
^ (b) Two
:::
^ Figure #: Group caption

See </#fig>, </#g>, </#one> and </#two>.
`

/**
 * The line the references sit on, and the column of each one. Derived from the
 * document rather than written down, so editing DOC cannot silently move an
 * assertion onto a blank line where every feature correctly answers nothing.
 */
const REF_LINE = DOC.split('\n').findIndex((line) => line.startsWith('See '))
const refColumn = (id: string): number => DOC.split('\n')[REF_LINE]!.indexOf(`</#${id}>`) + 3

/** The text the ENGINE renders for `</#id>`, read off the anchor it writes. */
const engineRefText = (source: string, id: string): string | null => {
  const match = new RegExp(`<a href="#${id}">([^<]*)</a>`).exec(carveToHtml(source))
  return match ? match[1]! : null
}

const targetFor = (source: string, id: string) =>
  captionTargets(resolve(parse(source, { positions: true }))).find((t) => t.id === id)

test('every caption id resolves to the text the engine renders for it', () => {
  for (const id of ['fig', 'g', 'one', 'two']) {
    assert.equal(
      targetFor(DOC, id)?.text,
      engineRefText(DOC, id),
      `crossref text for #${id} disagrees with the rendered anchor`,
    )
  }
  // Not merely "equal to each other": the group's own reference carries no
  // letter and its panels do, which is the rule under test.
  assert.equal(engineRefText(DOC, 'g'), 'Figure 2')
  assert.equal(engineRefText(DOC, 'one'), 'Figure 2a')
  assert.equal(engineRefText(DOC, 'two'), 'Figure 2b')
})

test('a stray block between panels does not take a letter', () => {
  // The paragraph sits between the two panels. If the walk counted children
  // rather than PANELS, the second panel would be "Figure 2c".
  assert.equal(targetFor(DOC, 'two')?.text, 'Figure 2b')
})

test('panel letters run a..z then aa', () => {
  assert.deepEqual([0, 1, 25, 26, 27, 51, 52].map(panelLetter), [
    'a',
    'b',
    'z',
    'aa',
    'ab',
    'az',
    'ba',
  ])
})

test('an unnumbered group registers anchors but no crossref text', () => {
  const source = `{#ug}\n::: figure\n{#u1}\n![u](u.png)\n^ (a) U\n:::\n^ No number here\n\nSee </#ug> and </#u1>.\n`
  assert.equal(targetFor(source, 'ug')?.text, null)
  assert.equal(targetFor(source, 'u1')?.text, null)
  // The engine agrees: it leaves both references as literal text rather than
  // linking them, which is what "not a caption crossref target" means (§4c).
  assert.equal(engineRefText(source, 'ug'), null)
  assert.equal(engineRefText(source, 'u1'), null)
})

test('go-to-definition on a crossref reaches the host, panel or not', () => {
  // `</#fig>` is the control: a captioned figure, no group involved, and it
  // jumped nowhere before this.
  const hostLine = (id: string): number | undefined =>
    definitionAt('file:///d.crv', DOC, { line: REF_LINE, character: refColumn(id) })?.range.start.line
  assert.equal(hostLine('fig'), 3)
  assert.equal(hostLine('g'), 7)
  assert.equal(hostLine('one'), 9)
})

test('a crossref hover names what the id resolves to', () => {
  const text = (id: string): string => {
    const hover = hoverAt(DOC, { line: REF_LINE, character: refColumn(id) })
    return typeof hover?.contents === 'object' && 'value' in hover.contents ? hover.contents.value : ''
  }
  assert.match(text('one'), /Figure 2a/)
  assert.match(text('one'), /panel/)
  assert.match(text('g'), /Figure 2/)
  // CONTROL. Before this, no `heading_ref` case existed and the lexical rules
  // took the `#` inside the reference, so every crossref hovered as a heading.
  assert.doesNotMatch(text('one'), /create section headings/)
})

test('find-references pairs a panel id with its usages', () => {
  const locations = referencesAt(
    'file:///d.crv',
    DOC,
    { line: REF_LINE, character: refColumn('one') },
    { includeDeclaration: true },
  )
  assert.deepEqual(locations?.map((location) => location.range.start.line), [9, REF_LINE])
})

test('crossref completion offers caption ids beside heading ids', () => {
  const source = DOC.replace('See </#fig>, </#g>, </#one> and </#two>.', 'See </#')
  const items = completionAt(source, { line: REF_LINE, character: 7 })
  const detail = (label: string): string | undefined => items.find((i) => i.label === label)?.detail

  assert.equal(detail('Section'), 'Heading id')
  assert.equal(detail('fig'), 'Figure 1 (figure)')
  assert.equal(detail('g'), 'Figure 2 (composite figure)')
  assert.equal(detail('one'), 'Figure 2a (panel)')
  assert.equal(detail('two'), 'Figure 2b (panel)')
})

test('an unnumbered host is not offered as a crossref target', () => {
  // Every id `</#` offers has to RESOLVE. An unnumbered host is a real anchor
  // and a fragment link reaches it, but a crossref to it renders as literal
  // text, so offering it here would be the one entry in the list that does not
  // work - the heading ids beside it all do.
  const source = `{#ug}\n::: figure\n{#u1}\n![u](u.png)\n^ (a) U\n:::\n^ No number here\n\nSee </#`
  const labels = completionAt(source, { line: 8, character: 7 }).map((item) => item.label)
  assert.deepEqual(labels, [])
})

test('find-references works from the declaration as well as from a usage', () => {
  // A heading declares its id on its own line; a captioned host declares it on
  // the block-attribute line ABOVE itself. Both are where an author puts the
  // cursor to ask "what points at this?".
  const fromAttributeLine = referencesAt('file:///d.crv', DOC, { line: 6, character: 2 }, {
    includeDeclaration: false,
  })
  const fromHostLine = referencesAt('file:///d.crv', DOC, { line: 7, character: 2 }, {
    includeDeclaration: false,
  })
  assert.deepEqual(fromAttributeLine?.map((location) => location.range.start.line), [REF_LINE])
  assert.deepEqual(fromHostLine?.map((location) => location.range.start.line), [REF_LINE])
})

test('a declaration inside a container still declares', () => {
  // The id's line is not always a bare `{#id}` at column 0. A shape test on it
  // reads like a safety check and is not one - a host only has an id because a
  // block-attribute line gave it one - so it can only reject a right answer.
  const quoted = '> {#fig}\n> ![a](a.png)\n> ^ Figure #: A\n\nSee </#fig>.\n'
  assert.deepEqual(
    referencesAt('file:///d.crv', quoted, { line: 0, character: 3 }, { includeDeclaration: false })
      ?.map((location) => location.range.start.line),
    [4],
  )
})

test('a line that declares no id declares nothing', () => {
  // CONTROL. The lookup keys on hosts that CARRY an id, not on hosts. An
  // uncaptioned-id figure has no entry, so the prose above it is just prose.
  assert.equal(
    referencesAt('file:///d.crv', 'Prose.\n![a](a.png)\n^ Figure #: A\n', { line: 0, character: 2 }, {
      includeDeclaration: false,
    }),
    null,
  )
  // And a line nowhere near a host answers nothing either.
  assert.equal(
    referencesAt('file:///d.crv', DOC, { line: 12, character: 2 }, { includeDeclaration: false }),
    null,
  )
})

test('a construct on the declaration line still wins', () => {
  // CONTROL for the declaration lookup, which is matched by LINE and so
  // answers for every column on it. A host line can carry a reference image,
  // and asking on its label must reach the link-reference definition rather
  // than the figure that happens to wrap it.
  const source = '{#fig}\n![alt][img]\n^ Figure #: C\n\n[img]: pic.png\n\nAgain [x][img].\n'
  const onLabel = referencesAt('file:///d.crv', source, { line: 1, character: 8 }, {
    includeDeclaration: true,
  })
  assert.deepEqual(onLabel?.map((location) => location.range.start.line), [1, 4, 6])

  // The same line still declares the figure where nothing else claims the
  // cursor - here, on the `!` that opens the image.
  const onHost = referencesAt('file:///d.crv', source, { line: 0, character: 2 }, {
    includeDeclaration: false,
  })
  assert.deepEqual(onHost?.map((location) => location.range.start.line), [])
})

test('the outline carries the group and nests its panels', () => {
  const symbols = analyzeCarve(DOC).symbols
  assert.equal(symbols.length, 1, 'the heading is still the only root')

  const group = symbols[0]!.children?.find((child) => child.name.startsWith('Figure 2'))
  assert.ok(group, `no group symbol under the heading: ${JSON.stringify(symbols[0]!.children)}`)
  assert.equal(group.name, 'Figure 2: Group caption')
  assert.equal(group.detail, '2 panels')
  assert.deepEqual(group.children?.map((panel) => panel.name), ['(a) One', '(b) Two'])
})

test('a group with no caption is still an outline entry, named for what it is', () => {
  const symbols = analyzeCarve('::: figure\n![a](a.png)\n^ (a) A\n:::\n').symbols
  assert.deepEqual(symbols.map((symbol) => symbol.name), ['Composite figure'])
  assert.equal(symbols[0]!.detail, '1 panel')
})

test('an uncaptioned panel falls back to the letter a crossref would use', () => {
  const symbols = analyzeCarve('::: figure\n| a |\n\n| b |\n:::\n^ Figure #: g\n').symbols
  assert.deepEqual(symbols[0]!.children?.map((panel) => panel.name), ['Panel a', 'Panel b'])
})

test('a heading is still a heading, wherever it sits relative to a group', () => {
  // CONTROL for the outline change. A group takes no heading level, so it must
  // not pop the stack: the section after it stays a sibling of the one before.
  const symbols = analyzeCarve(
    '# One\n\n::: figure\n![a](a.png)\n^ (a) A\n:::\n\n## Under one\n\n# Two\n',
  ).symbols
  assert.deepEqual(symbols.map((symbol) => symbol.name), ['One', 'Two'])
  assert.deepEqual(symbols[0]!.children?.map((child) => child.name), ['Composite figure', 'Under one'])
})

/*
 * The five §4c findings. The server derives none of them - it publishes what
 * `lintCarve` reports - so what is pinned here is that the passthrough works
 * and that the engine still emits each id under the pinned build. Nothing
 * asserted it before, so a passthrough that stopped would have been silent.
 */
const LINT_CASES: Array<[string, string]> = [
  ['figure-group-nested', '::: figure\n::: figure\nBody.\n:::\n:::\n^ Figure #: outer\n'],
  ['figure-group-opener-metadata', '::: figure "T"\n![a](a.png)\n^ (a) A\n:::\n'],
  ['figure-group-panel-number', '::: figure\n![a](a.png)\n^ Figure #: panel\n:::\n^ Figure #: group\n'],
  ['figure-group-empty', '::: figure\nJust text.\n:::\n^ Figure #: g\n'],
  ['figure-group-single-panel', '::: figure\n![a](a.png)\n^ (a) A\n:::\n^ Figure #: g\n'],
]

for (const [code, source] of LINT_CASES) {
  test(`${code} reaches the server's diagnostics`, () => {
    assert.ok(
      lintCarve(source).some((warning) => warning.rule === code),
      `the pinned engine no longer emits ${code}`,
    )
    assert.ok(
      analyzeCarve(source).diagnostics.some((diagnostic) => diagnostic.code === code),
      `${code} did not reach the server: ${JSON.stringify(
        analyzeCarve(source).diagnostics.map((d) => d.code),
      )}`,
    )
  })
}

test('a well-formed group reports none of them', () => {
  // CONTROL. Every case above differs from this document in one line, so a
  // passthrough that published a fixed list would look identical up there.
  const clean = '::: figure\n![a](a.png)\n^ (a) A\n\n![b](b.png)\n^ (b) B\n:::\n^ Figure #: g\n'
  const codes = analyzeCarve(clean).diagnostics.map((diagnostic) => diagnostic.code)
  assert.deepEqual(codes.filter((code) => String(code).startsWith('figure-group-')), [])
})
