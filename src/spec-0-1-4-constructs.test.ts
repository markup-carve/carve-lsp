import assert from 'node:assert/strict'
import { existsSync, readFileSync } from 'node:fs'
import test from 'node:test'
import { fileURLToPath } from 'node:url'
import { carveToHtml } from '@markup-carve/carve'
import { analyzeCarve } from './analyze.js'
import { continuationPrefix, formatDocument } from './format.js'

/**
 * The constructs carve 0.1.4 shipped, pinned against the corpus document that
 * rules each one.
 *
 * WHY BY CORPUS DOCUMENT. The server reads structure out of the engine, so most
 * of a new rule arrives with the engine bump and nothing here has to change -
 * which is exactly why a regression here would be silent. Reading the ruling
 * document off disk means these cases move when the spec pin moves, instead of
 * freezing a copy of the source that was right on the day it was typed.
 *
 * WHAT EACH CASE ASSERTS. That the server does not invent a diagnostic on markup
 * the engine accepts, that the formatter is byte-preserving and render-equivalent
 * on it, and - where the server has a rule of its own about the construct - that
 * the rule matches the ruling. Where the server has no behavior of its own, the
 * case says so rather than dressing up the engine's work as coverage.
 */

const corpusDir = fileURLToPath(new URL('../tests/spec/tests/corpus/', import.meta.url))

/** The `.crv` a corpus document was cut from, read through the pinned spec. */
function corpusDocument(name: string): string {
  const path = `${corpusDir}${name}.crv`
  assert.ok(existsSync(path), `corpus document ${name} is not in the pinned spec - has the ruling moved?`)
  return readFileSync(path, 'utf8')
}

/** Neither a diagnostic the engine did not raise, nor a byte the formatter moved. */
function serverIsQuietAndPreserving(source: string, label: string): void {
  assert.deepEqual(analyzeCarve(source, {}).diagnostics.map((d) => [d.code, d.range.start.line + 1]), [], label)
  assert.equal(formatDocument(source), source, `${label}: the formatter rewrote a document that already ends in a newline`)
  assert.equal(carveToHtml(formatDocument(source)), carveToHtml(source), `${label}: formatting changed the rendered document`)
}

test('the {empty} description sentinel is accepted, not diagnosed (PART 11 §7d, carve#1827)', () => {
  const source = corpusDocument('438-an-empty-description-body-is-written-with-the-empty-sentinel')
  assert.match(source, /^: \{empty\}$/m, 'corpus 438 no longer spells the sentinel')
  serverIsQuietAndPreserving(source, '{empty} sentinel')
  assert.match(carveToHtml(source), /<dd><\/dd>/, 'the sentinel should reach an empty description body')
  // The sentinel is content, so the marker did open a description: Enter lands
  // at the body column, where typing replaces the empty body with a real one
  // (`: {empty}` then `  x` renders <dd>x</dd>).
  assert.equal(continuationPrefix(':: t\n: {empty}\n', 2), '  ')
})

test('a colon followed by only whitespace opens no description (PART 2, carve#1830)', () => {
  const source = corpusDocument('439-a-colon-followed-by-only-whitespace-is-not-a-description')
  serverIsQuietAndPreserving(source, 'colon with no content')
  // The server's own rule about this construct: on-type continuation. A marker
  // that opened nothing has nothing to continue, and a tab separator is not a
  // marker at all.
  assert.equal(continuationPrefix(':: t\n: \n', 2), '')
  assert.equal(continuationPrefix(':: t\n:\n', 2), '')
  assert.equal(continuationPrefix(':: t\n:   \n', 2), '')
  assert.equal(continuationPrefix(':: t\n:\tbody\n', 2), '')
  // And the near miss it must not swallow: a real marker still continues, at the
  // content column its separator run sets (corpus 424).
  assert.equal(continuationPrefix(':: t\n: body\n', 2), '  ')
  assert.equal(continuationPrefix(':: t\n:   body\n', 2), '    ')
  assert.equal(continuationPrefix(':: t\n  : body\n', 2), '    ')
  // An invisible line is content for this purpose - corpus 436 keeps the body.
  assert.equal(continuationPrefix(':: t\n:  %% c\n', 2), '   ')
  // NOT RULED HERE. `: ` followed by a tab is carve#1836, deferred past this
  // release with all three engines wrong about it in two different ways - the
  // pinned carve-js reads it as a description body, which is what makes the
  // question live. The server keeps the answer it gave before the rule above
  // landed rather than picking a side; this line exists so that when carve#1836
  // does land, someone has to come back to it.
  assert.equal(continuationPrefix(':: t\n: \tbody\n', 2), '  ')
})

test('the continuation marker reaches column 0 and nothing else (PART 9 §17 L3, carve#1817)', () => {
  for (const name of [
    '435-the-continuation-marker-s-column-gate-reaches-every-container',
    '437-a-leading-continuation-marker-in-a-footnote-body-or-a-quote-is-text',
  ]) serverIsQuietAndPreserving(corpusDocument(name), name)
  // A lone `+` is not a bullet, so nothing may continue a line that is only one -
  // in either reading of it. This is the server's whole behavior on the marker:
  // it has no continuation, no fold and no token of its own, and a change that
  // gave it one would have to decide the two readings apart first.
  assert.equal(continuationPrefix('- item\n+\n', 2), '')
  assert.equal(continuationPrefix('[^a]: intro\n+\n', 2), '')
})

test('a block image keeps its caption slot (PART 11 §1c, carve#1823)', () => {
  const source = corpusDocument('434-an-unresolved-image-gives-its-whole-caption-slot-back-at-any-depth')
  serverIsQuietAndPreserving(source, 'block image carve-out')
  // The promotion the clause is about is visible to the server only as a
  // `figure` in the tree, which is what the caption and crossref features read.
  assert.match(carveToHtml('![alt](a.png)\n^ Caption\n'), /<figure>[\s\S]*<figcaption>Caption<\/figcaption>/)
  // An image that shares its paragraph is not a block image, so no figure.
  assert.doesNotMatch(carveToHtml('text ![alt](a.png)\n'), /<figure>/)
})

test('a fenced block quote is continued as the container it is (carve#1718)', () => {
  // The 0.1.4 spelling of a quote goes through the colon-fence branch, so Enter
  // after the opener writes the closer rather than a `>` prefix.
  assert.equal(continuationPrefix('::: >\n', 1), '\n:::')
  assert.equal(continuationPrefix('  :::: >\n', 1), '\n  ::::')
  assert.equal(continuationPrefix('> quoted\n', 1), '> ')
})
