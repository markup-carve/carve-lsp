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
// Usage: node tools/corpus-through-server.mjs <corpus-dir> [--json]
// Prints `documents=`, `threw=`, `tokens=`, `diagnostics=` lines, and one line
// per document that threw.

import { readdirSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import { argv, exit, stdout } from 'node:process'

const corpusDir = argv[2]
if (!corpusDir) {
  stdout.write('usage: node tools/corpus-through-server.mjs <corpus-dir>\n')
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

for (const name of documents) {
  const source = readFileSync(join(corpusDir, name), 'utf8')
  try {
    const analysis = analyzeCarve(source)
    diagnostics += analysis.diagnostics.length
    tokens += semanticTokens(source).length
  } catch (error) {
    threw += 1
    failures.push(`${name}: ${error instanceof Error ? error.message : String(error)}`)
  }
}

for (const failure of failures) stdout.write(`threw: ${failure}\n`)
stdout.write(`documents=${documents.length}\n`)
stdout.write(`threw=${threw}\n`)
stdout.write(`tokens=${tokens}\n`)
stdout.write(`diagnostics=${diagnostics}\n`)
