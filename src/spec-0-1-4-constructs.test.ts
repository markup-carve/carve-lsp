import assert from 'node:assert/strict'
import test from 'node:test'
import { render } from './engine.js'
import { analyzeCarve } from './analyze.js'
import { continuationPrefix, formatDocument, listContinuationEdits } from './format.js'

/**
 * The constructs carve 0.1.4 shipped, pinned against the corpus document that
 * rules each one.
 *
 * WHY BY CORPUS DOCUMENT. The server reads structure out of the engine, so most
 * of a new rule arrives with the engine bump and nothing here has to change -
 * which is exactly why a regression here would be silent. The 0.1 corpus that
 * held the ruling documents is gone from carve `next2`, so the documents are kept
 * below as they stood at the last 0.1 pin.
 *
 * WHAT EACH CASE ASSERTS. That the server does not invent a diagnostic on markup
 * the engine accepts, that the formatter is byte-preserving and render-equivalent
 * on it, and - where the server has a rule of its own about the construct - that
 * the rule matches the ruling. Where the server has no behavior of its own, the
 * case says so rather than dressing up the engine's work as coverage.
 */

/**
 * The 0.1 corpus documents these cases were cut from. carve `next2` dropped the
 * 0.1 corpus (carve#6092), so their source is kept here as it stood at the last
 * 0.1 pin (carve 51c5631).
 */
const CORPUS_0_1: Record<string, string> = {
  '434-an-unresolved-image-gives-its-whole-caption-slot-back-at-any-depth': '![a][r]\n^ cap one\ncontinued\n',
  '435-the-continuation-marker-s-column-gate-reaches-every-container': '[^a]: intro\n%% c\n more\n\nsee[^a]\n',
  '437-a-first-block-marker-in-a-footnote-body-or-a-quote-attaches-only-at-its-marker-column': '[^a]: +\nflush\n\nsee[^a]\n',
  '438-an-empty-description-body-is-written-with-the-empty-sentinel': ':: t\n: {empty}\n\nflush\n',
  '439-a-colon-followed-by-only-whitespace-is-not-a-description': ':: t\n: \n\nflush\n',
}

function corpusDocument(name: string): string {
  const source = CORPUS_0_1[name]
  assert.ok(source !== undefined, `corpus document ${name} is not kept here`)
  return source
}

/** Neither a diagnostic the engine did not raise, nor a byte the formatter moved. */
function serverIsQuietAndPreserving(source: string, label: string, engineRaises: Array<[string, number]> = []): void {
  assert.deepEqual(analyzeCarve(source, {}).diagnostics.map((d) => [d.code, d.range.start.line + 1]), engineRaises, label)
  assert.equal(formatDocument(source), source, `${label}: the formatter rewrote a document that already ends in a newline`)
  assert.equal(render(formatDocument(source)), render(source), `${label}: formatting changed the rendered document`)
}

test('the {empty} description sentinel is accepted, not diagnosed (PART 11 §7d, carve#1827)', () => {
  const source = corpusDocument('438-an-empty-description-body-is-written-with-the-empty-sentinel')
  assert.match(source, /^: \{empty\}$/m, 'corpus 438 no longer spells the sentinel')
  serverIsQuietAndPreserving(source, '{empty} sentinel')
  // 0.2 U-142: `{empty}` is no sentinel any more; it is printed as the description's text.
  assert.match(render(source), /<dd>\{empty\}<\/dd>/, 'the 0.2 description body holds the literal text')
  // The sentinel is content, so the marker did open a description: Enter
  // starts the next definition, as after any other one. The prefix fallback
  // still lands at the body column (`: {empty}` then `  x` renders <dd>x</dd>).
  assert.deepEqual(listContinuationEdits(':: t\n: {empty}\n', { line: 2, character: 0 })?.map((edit) => edit.newText), [': '])
  assert.equal(continuationPrefix(':: t\n: {empty}\n', 2), '  ')
})

test('a colon followed by only whitespace opens no description (PART 2, carve#1830)', () => {
  const source = corpusDocument('439-a-colon-followed-by-only-whitespace-is-not-a-description')
  // 0.2 lint-rules.json `description-term-multi-line` (C2-B-069, new in 0.2) reports the term the bare colon joins.
  serverIsQuietAndPreserving(source, 'colon with no content', [['description-term-multi-line', 2]])
  // The server's own rule about this construct: on-type continuation. A marker
  // that opened nothing has nothing to continue, and a tab separator is not a
  // marker at all.
  assert.equal(continuationPrefix(':: t\n: \n', 2), '')
  assert.equal(continuationPrefix(':: t\n:\n', 2), '')
  assert.equal(continuationPrefix(':: t\n:   \n', 2), '')
  assert.equal(continuationPrefix(':: t\n:\tbody\n', 2), '')
  // On Enter a whitespace-only marker is removed, ending the list, as an empty
  // list marker is; a tab separator is not a marker, so nothing happens.
  assert.deepEqual(listContinuationEdits(':: t\n: \n', { line: 2, character: 0 })?.map((edit) => edit.newText), [''])
  assert.equal(listContinuationEdits(':: t\n:\tbody\n', { line: 2, character: 0 }), null)
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
  assert.equal(listContinuationEdits(':: t\n: \tbody\n', { line: 2, character: 0 }), null)
})

test('the continuation marker reaches column 0 and nothing else (PART 9 §17 L3, carve#1817)', () => {
  for (const name of [
    '435-the-continuation-marker-s-column-gate-reaches-every-container',
    '437-a-first-block-marker-in-a-footnote-body-or-a-quote-attaches-only-at-its-marker-column',
  ]) serverIsQuietAndPreserving(corpusDocument(name), name)
  // A lone `+` is not a bullet, so nothing may continue a line that is only one -
  // in either reading of it. The list item above it continues; the `+` does not.
  assert.equal(listContinuationEdits('- item\n\n', { line: 1, character: 0 })?.[0]?.newText, '- ')
  assert.equal(listContinuationEdits('- item\n+\n', { line: 2, character: 0 }), null)
  assert.equal(continuationPrefix('- item\n+\n', 2), '')
  assert.equal(continuationPrefix('[^a]: intro\n+\n', 2), '')
})

test('a block image keeps its caption slot (PART 11 §1c, carve#1823)', () => {
  const source = corpusDocument('434-an-unresolved-image-gives-its-whole-caption-slot-back-at-any-depth')
  // `[r]` has no definition, which carve-js 0.1.10 and later lint.
  serverIsQuietAndPreserving(source, 'block image carve-out', [['unresolved-reference-link', 1]])
  // The promotion the clause is about is visible to the server only as a
  // `figure` in the tree, which is what the caption and crossref features read.
  assert.match(render('![alt](a.png)\n^ Caption\n'), /<figure>[\s\S]*<figcaption>Caption<\/figcaption>/)
  // An image that shares its paragraph is not a block image, so no figure.
  assert.doesNotMatch(render('text ![alt](a.png)\n'), /<figure>/)
})

test('a fenced block quote is continued as the container it is (carve#1718)', () => {
  // The 0.1.4 spelling of a quote goes through the colon-fence branch, so Enter
  // after the opener writes the closer rather than a `>` prefix.
  assert.equal(continuationPrefix('::: >\n', 1), '\n:::')
  assert.equal(continuationPrefix('> :::: >\n', 1), '> \n> ::::')
  assert.equal(continuationPrefix('> quoted\n', 1), '> ')
})
