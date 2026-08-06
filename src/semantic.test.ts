import assert from 'node:assert/strict'
import test from 'node:test'
import { DEF_SEPARATOR, LIST_MARKER_ONLY, LIST_PREFIX, QUOTE_PREFIX, semanticTokens } from './semantic.js'

/*
 * A marker separator is a literal space.
 *
 * The grammar keeps `whitespace = ' ' | '\t'` and `space = ' '` apart on
 * purpose, and every marker below takes `space`. Seven patterns across three
 * functions matched them with `\s`, so the editor colored a checkbox, a quote
 * marker and a reference label on lines every engine renders as ordinary
 * paragraph text (carve-lsp#38, part of the sweep in carve#878).
 *
 * The patterns are asserted DIRECTLY. Only the definition markers are
 * observable through `semanticTokens`, because it prefers the AST path and the
 * pinned engine is old enough to still make `><TAB>q` a blockquote
 * (carve-lsp#37) - a test through it would measure the dependency rather than
 * the rule. The definition tests below go end-to-end for exactly that reason:
 * they are the half that can.
 */

const defRef = new RegExp(String.raw`^(\[)([^\]\n]+)(` + DEF_SEPARATOR + String.raw`)(\S+)`)
const kinds = (source: string) => semanticTokens(source).map((t) => t.type).join(',')

test('a tab after a definition colon does not satisfy the separator', () => {
  assert.equal(defRef.exec('[a]:\t/u'), null)
})

test('a definition still needs its space at all', () => {
  // `\s*` matched NONE as well, so this direction was wrong too: every engine
  // renders `[a]:/u` as a paragraph.
  assert.equal(defRef.exec('[a]:/u'), null)
})

test('further whitespace after the required space is still a definition', () => {
  // Measured against the engine: `[a]: <TAB>/u` DOES define. The rule is that
  // the separator STARTS with a literal space, not that the whole run is
  // spaces - which is where these markers differ from the task marker below.
  assert.ok(defRef.exec('[a]: \t/u'))
  assert.ok(defRef.exec('[a]:  /u'))
  assert.ok(defRef.exec('[a]: /u'))
})

test('a tab after a blockquote marker is not a quote', () => {
  assert.equal(QUOTE_PREFIX.exec('>\tq'), null)
})

test('a bare marker is still a blockquote line', () => {
  // `blockquote_line = '>', (newline | (space, inline_content, newline))` - the
  // space is optional only at end of line, which a plainly-required space would
  // have broken.
  assert.ok(QUOTE_PREFIX.exec('>'))
  assert.ok(QUOTE_PREFIX.exec('> q'))
  assert.ok(QUOTE_PREFIX.exec('\t> q'))
})

test('a tab after a task checkbox is not a task marker', () => {
  assert.equal(LIST_PREFIX.exec('- [ ]\ta')?.[3], undefined)
})

test('a space then a tab is not a task marker either', () => {
  // Measured: the engine renders `- [ ] <TAB>a` as a plain bullet whose content
  // is the literal text `[ ] <TAB>a`. The separator run is spaces and content
  // has to follow it.
  assert.equal(LIST_PREFIX.exec('- [ ] \ta')?.[3], undefined)
})

test('the space spelling is still a task marker', () => {
  assert.ok(LIST_PREFIX.exec('- [ ] a')?.[3])
  assert.ok(LIST_PREFIX.exec('- [ ]  a')?.[3])
})

test('a plus is not a bullet', () => {
  // `bullet_marker = '-' | '*'`. `+` is the list CONTINUATION marker, so a
  // `+ ` line is paragraph text and must not be colored as a list marker.
  assert.equal(LIST_PREFIX.exec('+ a'), null)
  assert.equal(LIST_MARKER_ONLY.exec('+ a'), null)
  assert.ok(LIST_PREFIX.exec('- a'))
  assert.ok(LIST_PREFIX.exec('* a'))
})

test('a tab after a bullet is not a list marker', () => {
  assert.equal(LIST_PREFIX.exec('-\ta'), null)
})

test('the states beyond x and X are still task markers', () => {
  // `task_state = ' ' | 'x' | 'X' | '-' | '_' | '>' | '?'`. Four of the seven
  // were absent from the old class, so those checkboxes were never colored.
  for (const state of [' ', 'x', 'X', '-', '_', '>', '?']) {
    assert.ok(LIST_PREFIX.exec(`- [${state}] a`)?.[3], `state ${JSON.stringify(state)}`)
  }
})

test('a tab-separated definition is not colored as one', () => {
  // The half that IS observable end-to-end, through the AST-gap scan.
  assert.notEqual(kinds('[a]:\t/u\n'), kinds('[a]: /u\n'))
  assert.notEqual(kinds('[^a]:\tn\n'), kinds('[^a]: n\n'))
  assert.notEqual(kinds('*[HTML]:\tHyperText\n'), kinds('*[HTML]: HyperText\n'))
})

test('the space spellings all still tokenize', () => {
  // The control. Nearly every assertion above is a negative, so a build that
  // emitted no tokens at all would pass them.
  for (const source of ['[a]: /u\n', '[^a]: n\n', '*[HTML]: H\n', '> q\n', '- [ ] a\n', '- a\n']) {
    assert.ok(semanticTokens(source).length > 0, source)
  }
})
