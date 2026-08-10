import assert from 'node:assert/strict'
import test from 'node:test'
import { hoverAt } from './hover.js'
import { semanticTokens } from './semantic.js'
import {
  astColumnToCharacter,
  characterToAstColumn,
  engineColumnUnit,
  setEngineColumnUnit,
  CODEPOINT_PROBE_END_COLUMN,
  COLUMN_PROBE,
  probeEndColumn,
} from './position.js'
import type { Hover } from 'vscode-languageserver/node.js'

function hoverText(hover: Hover): string {
  const contents = hover.contents as { value?: string }
  return contents.value ?? String(hover.contents)
}

// Every assertion below is written against the SOURCE, not against the parser's
// numbers: an LSP character is a UTF-16 index into the line, so `indexOf` is
// the answer a client expects no matter which unit the installed parser counts
// in. That is what makes these hold across the carve-js release that switched
// columns from UTF-16 code units to codepoints (carve-js#447) - the release
// this server's `^0.1.2` range picks up without a change here.

const LINE = '\u{1F600} *bold* tail'
const BOLD_START = LINE.indexOf('*')
const BOLD_END = LINE.lastIndexOf('*') + 1

// The unit the PINNED engine reports, asserted directly.
//
// The test above is deliberately unit-agnostic, so a release that changes the
// unit passes it - which is how the change got in last time. This one names the
// answer, so the change arrives as a failing assertion instead of as correct
// positions on ASCII and wrong ones on every emoji.
//
// That is exactly what happened: this assertion read `utf16` while the pin sat
// at `0.1.2`, and raising the pin to `0.1.3` turned it red. `0.1.3` carries
// carve-js#447, which counts codepoints and so conforms to spec PART 12
// section 4. The expectation is flipped here rather than relaxed, because an
// assertion that accepts either unit is the shape that let the change through
// unnoticed the first time.
//
// The conversions in position.js have always had both branches; until this
// release the `codepoint` one was unreachable with the installed engine. It is
// the live branch now, and the unit-agnostic tests above cover it: they derive
// every expectation from `indexOf` on the SOURCE, so they would fail if the
// conversion returned the parser's raw codepoint column to an LSP client.
test('the pinned engine counts codepoints', () => {
  assert.equal(engineColumnUnit(), 'codepoint')
})

// This test used to retype the probe string and the constant, and then assert
// that engineColumnUnit() agreed with a recomputation of its own expression:
//
//   const endColumn = parse('\u{1F600}x').children[0]?.pos?.endColumn
//   assert.equal(engineColumnUnit(), endColumn === 3 ? 'codepoint' : 'utf16')
//
// Both sides read the same value through the same expression, so they agreed
// for every value the engine can return - including `undefined`, where both
// take the `utf16` branch and the "answer" is the catch-all rather than a
// measurement. Two mutations, both measured against the old assertion, both
// leaving the whole suite green at 134 of 134:
//
//   COLUMN_PROBE = 'abc'   a BMP-only probe has the same end column under
//                          either unit, so the classifier can no longer tell
//                          them apart. The test reparsed its own emoji probe
//                          and never saw it.
//   the classifier reads a property that does not exist, so every
//                          classification is the fallback. The test reparsed
//                          and got a real number, so it agreed with the
//                          fallback and reported nothing.
//
// What follows checks three things separately, against values derived from the
// probe rather than copied from it, and consumes the classifier's own reading
// rather than making a second one.
test('the probe can tell the two units apart', () => {
  // A string is indexed in UTF-16 code units and iterated in codepoints, so a
  // probe whose two lengths are equal reports the same end column under either
  // unit and classifies nothing. This is a property of the probe alone, with no
  // engine involved.
  assert.notEqual(
    COLUMN_PROBE.length,
    [...COLUMN_PROBE].length,
    'the probe has no astral character, so both units give it the same end column',
  )
  // And the constant the classifier compares against is that probe's codepoint
  // end column - derived here, hard-coded there.
  assert.equal(CODEPOINT_PROBE_END_COLUMN, [...COLUMN_PROBE].length + 1)
})

test('the installed parser answers the probe, rather than failing into the default', () => {
  // engineColumnUnit() answers `utf16` when the parse throws or the position is
  // absent. That is the right thing for a server not to crash on, and the wrong
  // thing to accept silently in CI: a classification nobody measured reads
  // exactly like one that was.
  //
  // probeEndColumn() rather than a reparse here: this is the reading the
  // classifier actually makes, so a classifier that stops reading a position
  // fails this. A reparse would agree with the fallback and report nothing.
  const endColumn = probeEndColumn()
  assert.equal(
    typeof endColumn,
    'number',
    'the installed engine placed no position on the probe, so the unit below is a default, not a reading',
  )
  // Only two answers are possible for this probe, one per unit. Anything else
  // means the engine is not counting either of the units this server knows how
  // to convert between.
  assert.ok(
    endColumn === [...COLUMN_PROBE].length + 1 || endColumn === COLUMN_PROBE.length + 1,
    `the probe's end column is ${endColumn}, which is neither its codepoint length + 1 ` +
      `(${[...COLUMN_PROBE].length + 1}) nor its UTF-16 length + 1 (${COLUMN_PROBE.length + 1})`,
  )
  assert.equal(engineColumnUnit(), endColumn === [...COLUMN_PROBE].length + 1 ? 'codepoint' : 'utf16')
})

test('an emoji before a construct does not shift its hover range', () => {
  const hover = hoverAt(LINE, { line: 0, character: BOLD_START + 1 })
  assert.ok(hover, 'expected a hover inside the bold span')
  assert.match(hoverText(hover), /Bold/)
  assert.deepEqual(hover.range, {
    start: { line: 0, character: BOLD_START },
    end: { line: 0, character: BOLD_END },
  })
})

test('a cursor placed by UTF-16 character finds the node the client pointed at', () => {
  // The character an editor sends counts UTF-16 units. Compared against a
  // codepoint column without converting, this cursor lands one position early
  // and hovers the surrounding text instead of the bold span.
  const hover = hoverAt(LINE, { line: 0, character: BOLD_END - 2 })
  assert.ok(hover)
  assert.match(hoverText(hover), /Bold/)
})

test('semantic tokens land on the UTF-16 columns the client indexes by', () => {
  const tokens = semanticTokens(LINE)
  const bold = tokens.find((token) => token.character === BOLD_START)
  assert.ok(bold, `expected a token at character ${BOLD_START}, got ${JSON.stringify(tokens)}`)
  assert.equal(bold.length, BOLD_END - BOLD_START)
})

test('both parser readings map the same construct to the same LSP character', () => {
  // The installed parser can only show one reading, and it is the one whose
  // conversion is the identity - so the other branch is driven explicitly
  // rather than left to run for the first time after a dependency bump.
  // In `LINE` the opening `*` is codepoint column 3 and UTF-16 column 4,
  // because the emoji is one codepoint and two code units.
  try {
    setEngineColumnUnit('codepoint')
    assert.equal(astColumnToCharacter(LINE, 3), BOLD_START)
    assert.equal(characterToAstColumn(LINE, BOLD_START), 3)

    setEngineColumnUnit('utf16')
    assert.equal(astColumnToCharacter(LINE, 4), BOLD_START)
    assert.equal(characterToAstColumn(LINE, BOLD_START), 4)
  } finally {
    setEngineColumnUnit(undefined)
  }
})

test('a BMP-only document is unaffected either way', () => {
  const line = 'a *bold* tail'
  const hover = hoverAt(line, { line: 0, character: 3 })
  assert.ok(hover)
  assert.deepEqual(hover.range, {
    start: { line: 0, character: line.indexOf('*') },
    end: { line: 0, character: line.lastIndexOf('*') + 1 },
  })
})
