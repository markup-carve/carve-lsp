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
// per document that threw.
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
