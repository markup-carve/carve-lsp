import assert from 'node:assert/strict'
import test from 'node:test'
import { parse } from '@markup-carve/carve'
import { hoverAt } from './hover.js'
import { semanticTokens } from './semantic.js'
import {
  astColumnToCharacter,
  characterToAstColumn,
  engineColumnUnit,
  setEngineColumnUnit,
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

test('the probe agrees with the installed parser', () => {
  // Not a tautology: it reads the engine's answer for a known string rather
  // than the probe's own logic. If the two ever disagree, every conversion
  // below is running in the wrong direction.
  const endColumn = parse('\u{1F600}x').children[0]?.pos?.endColumn
  assert.equal(engineColumnUnit(), endColumn === 3 ? 'codepoint' : 'utf16')
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
