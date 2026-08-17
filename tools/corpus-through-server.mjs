// Drive every spec corpus document through the BUILT server, with whatever
// engine is currently installed under node_modules.
//
// A version comparison says how far the engine is from the language. It cannot
// say what this server DOES with that engine, and the two answers differ: the
// AST vocabulary is what the analysis switches on, so a renamed node type is a
// silently lost token rather than an error. `footnote` -> `footnote_ref` and
// `critic-comment` -> `critic_comment` both already happened inside the `0.1.x`
// line (carve#405), and both were caught by hand rather than by a job.
//
// Run it twice - once with the pinned engine, once with a build of carve-js
// `main` dropped into node_modules - and the difference between the two runs is
// what upgrading would do to this server. The build itself is not repeated:
// `dist/` is plain JavaScript, so a `case` arm naming a node type the newer
// engine no longer emits is dead at runtime rather than a compile error, which
// is exactly the state this measures.
//
// Usage: node tools/corpus-through-server.mjs <corpus-dir> [--manifest <file>]
// Prints `documents=`, `threw=`, `tokens=`, `diagnostics=` lines, and one line
// per document that threw. Exits 1 without measuring anything when the corpus
// is not the whole corpus - see the population guard below for why that is a
// failure rather than a smaller run.
//
// The totals alone cannot answer the question the two runs are compared for.
// They are SUMS over the corpus, so a document that loses semantic tokens and
// another that gains the same number leave every total identical, and the
// comparison reports that the engine bump changes nothing while the server has
// in fact stopped tokenizing one construct and started tokenizing another. That
// is the "compare counts, not sets" defect (carve#927): two different
// distributions of the same size compare equal.
//
// `--manifest <file>` therefore writes one TAB-separated row per document -
// name, tokens, diagnostics - so the two runs can be compared as SETS of rows
// and the swap above shows up as two changed rows rather than as silence.

import { readdirSync, readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { argv, exit, stdout } from 'node:process'

const corpusDir = argv[2]
if (!corpusDir) {
  stdout.write('usage: node tools/corpus-through-server.mjs <corpus-dir> [--manifest <file>]\n')
  exit(2)
}

const manifestFlag = argv.indexOf('--manifest')
const manifestPath = manifestFlag === -1 ? null : argv[manifestFlag + 1]
if (manifestFlag !== -1 && !manifestPath) {
  stdout.write('--manifest needs a file path\n')
  exit(2)
}

const { analyzeCarve } = await import('../dist/analyze.js')
const { semanticTokens } = await import('../dist/semantic.js')

const documents = readdirSync(corpusDir)
  .filter((name) => name.endsWith('.crv'))
  .sort()

/*
 * A RUNNER MUST NOT REPORT SUCCESS OVER AN EMPTY OR SHORT POPULATION.
 *
 * This one did. Measured before this guard: pointed at an empty directory it
 * printed `documents=0 threw=0 tokens=0 diagnostics=0` and exited 0, and the
 * whole `future-engine` job went green on it - `threw` is 0, both manifests are
 * empty, so the set comparison finds no changed row and reports "no document is
 * read differently under carve-js main". Pointed at 623 of the corpus's 830
 * documents it did the same, at a quarter of the corpus missing. Every
 * conclusion that job draws is a statement about a population it never checked
 * the size of. This is the variant-2 defect of markup-carve/carve#755, with the
 * shared helper and the convention in markup-carve/carve#955.
 *
 * THE COMPARISON IS AGAINST SOMETHING THIS RUNNER DOES NOT WRITE. Deriving the
 * expected count from the directory being read would be a check reading its own
 * frozen input wearing a fix for a check that passes over nothing: empty the
 * directory and both sides move together. That exact mistake was made and caught
 * in markup-carve/pandoc-carve.
 *
 * tests/corpus is GENERATED from the `::: compare` blocks in
 * resources/examples/{core,extensions,edge-cases}.md, and the generator
 * refuses to write a corpus where the two disagree (see tests/corpus/README.md and
 * scripts/generate-corpus.mjs in the spec repository). Those pages sit two
 * directories up from the corpus, in the same checkout the workflow already
 * clones. Counting them is an independent statement of how many documents there
 * should be, and it leaves no literal here to go stale: adding an example moves
 * the expectation on the next corpus rebuild.
 *
 * Equality rather than a floor, deliberately: a floor cannot tell a whole corpus
 * from a truncated checkout, and truncation is the failure being guarded
 * against.
 */
const EXAMPLE_PAGES = ['core.md', 'extensions.md', 'edge-cases.md']
const COMPARE_OPEN = /^:{3,}\s+compare(\s+\S.*)?$/

// Mirrors the generator's state machine rather than grepping: a `::: compare`
// line inside an already-open block is content, not a second pair, and a block
// closes on a bare marker line.
const declaredCorpusSize = () => {
  const examplesDir = join(corpusDir, '..', '..', 'resources', 'examples')
  let declared = 0
  for (const page of EXAMPLE_PAGES) {
    const path = join(examplesDir, page)
    let source
    try {
      source = readFileSync(path, 'utf8')
    } catch (error) {
      stdout.write(
        `corpus-through-server: no corpus source page at ${path} ` +
          `(${error instanceof Error ? error.message : String(error)}).\n` +
          '  tests/corpus is generated from those pages, and they are how this run knows\n' +
          '  how many documents it should have seen. Without them there is nothing to\n' +
          '  compare the corpus against, and a run over an unknown population is not a\n' +
          '  result. Point <corpus-dir> at tests/corpus inside a markup-carve/carve\n' +
          '  checkout.\n',
      )
      exit(1)
    }
    let marker = null
    for (const rawLine of source.split('\n')) {
      const line = rawLine.trim()
      if (marker !== null) {
        if (line === marker) marker = null
        continue
      }
      if (COMPARE_OPEN.test(line)) {
        declared++
        marker = line.match(/^:{3,}/)[0]
      }
    }
  }
  return declared
}

const declared = declaredCorpusSize()
if (declared === 0) {
  stdout.write(
    'corpus-through-server: the corpus source pages declare no ::: compare blocks at all.\n' +
      '  This is a wiring problem, not a corpus of size zero.\n',
  )
  exit(1)
}
if (documents.length !== declared) {
  stdout.write(
    `corpus-through-server: ${corpusDir} holds ${documents.length} documents, ` +
      `but the spec's example pages declare ${declared}.\n` +
      '  Every ::: compare block in resources/examples/{core,extensions,edge-cases}.md becomes\n' +
      '  one corpus pair, so a difference means this is not the corpus those pages\n' +
      '  describe: a truncated or stale checkout, a wrong <corpus-dir>, or a corpus that\n' +
      '  needs regenerating (npm run corpus:build in the spec repository). Every number\n' +
      '  below would describe a population nobody chose.\n',
  )
  exit(1)
}

let threw = 0
let tokens = 0
let diagnostics = 0
const failures = []
const rows = []

for (const name of documents) {
  const source = readFileSync(join(corpusDir, name), 'utf8')
  try {
    const analysis = analyzeCarve(source)
    const docDiagnostics = analysis.diagnostics.length
    const docTokens = semanticTokens(source).length
    diagnostics += docDiagnostics
    tokens += docTokens
    rows.push(`${name}\t${docTokens}\t${docDiagnostics}`)
  } catch (error) {
    threw += 1
    failures.push(`${name}: ${error instanceof Error ? error.message : String(error)}`)
    // A document that threw still gets a row, so that a document which starts
    // throwing shows up as a CHANGED row rather than a vanished one - a missing
    // row is easy to read as "no longer in the corpus".
    rows.push(`${name}\tthrew\tthrew`)
  }
}

// `documents` is already sorted, so the manifest is deterministic and two runs
// can be compared line by line.
if (manifestPath) writeFileSync(manifestPath, rows.map((row) => `${row}\n`).join(''))

for (const failure of failures) stdout.write(`threw: ${failure}\n`)
stdout.write(`documents=${documents.length}\n`)
stdout.write(`threw=${threw}\n`)
stdout.write(`tokens=${tokens}\n`)
stdout.write(`diagnostics=${diagnostics}\n`)
