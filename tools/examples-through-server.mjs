// Drives every input of the 0.2 conformance examples of a carve checkout
// (`spec/0.2/conformance/examples.json`) through the built server: analysis and
// semantic tokens. Fails when the server throws on any of them, or when the file
// states no examples at all. The 0.2 counterpart of corpus-through-server.mjs,
// whose 0.1 corpus carve `main` no longer carries.
import { readFileSync, writeFileSync } from 'node:fs'
import { argv, exit, stdout } from 'node:process'

const examplesPath = argv[2]
if (!examplesPath) {
  stdout.write('usage: node tools/examples-through-server.mjs <examples.json> [--manifest <file>] [--allow-throws]\n')
  exit(2)
}
const manifestFlag = argv.indexOf('--manifest')
const manifestPath = manifestFlag === -1 ? null : argv[manifestFlag + 1]
if (manifestFlag !== -1 && (!manifestPath || manifestPath.startsWith('--'))) {
  stdout.write('--manifest needs a file path\n')
  exit(2)
}
const allowThrows = argv.includes('--allow-throws')

const { analyzeCarve } = await import('../dist/analyze.js')
const { semanticTokens } = await import('../dist/semantic.js')

const { examples } = JSON.parse(readFileSync(examplesPath, 'utf8'))
const inputs = examples.filter((example) => typeof example.input === 'string')
if (inputs.length === 0) {
  stdout.write(`examples-through-server: ${examplesPath} states no example input; this is a wiring problem.\n`)
  exit(1)
}
const ids = new Set()
for (const { id } of inputs) {
  if (typeof id !== 'string' || !id || id.includes('\t') || id.includes('\n') || ids.has(id)) {
    stdout.write(`examples-through-server: missing, invalid, or duplicate example id: ${String(id)}\n`)
    exit(1)
  }
  ids.add(id)
}

let tokens = 0
let diagnostics = 0
const failures = []
const rows = []
for (const { id, input } of inputs) {
  try {
    const docDiagnostics = analyzeCarve(input).diagnostics.length
    const docTokens = semanticTokens(input).length
    diagnostics += docDiagnostics
    tokens += docTokens
    rows.push(`${id}\t${docTokens}\t${docDiagnostics}`)
  } catch (error) {
    failures.push(`${id}: ${error instanceof Error ? error.message : String(error)}`)
    rows.push(`${id}\tthrew\tthrew`)
  }
}

if (manifestPath) writeFileSync(manifestPath, rows.map((row) => `${row}\n`).join(''))
for (const failure of failures) stdout.write(`threw: ${failure}\n`)
stdout.write(`documents=${inputs.length}\nthrew=${failures.length}\ntokens=${tokens}\ndiagnostics=${diagnostics}\n`)
if (failures.length > 0 && !allowThrows) {
  stdout.write(`::error::the server threw on ${failures.length} of ${inputs.length} spec examples\n`)
  exit(1)
}
