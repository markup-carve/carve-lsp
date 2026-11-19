// Drives every input of the 0.2 conformance examples of a carve checkout
// (`spec/0.2/conformance/examples.json`) through the built server: analysis and
// semantic tokens. Fails when the server throws on any of them, or when the file
// states no examples at all. The 0.2 counterpart of corpus-through-server.mjs,
// whose 0.1 corpus carve `next2` no longer carries.
import { readFileSync } from 'node:fs'
import { argv, exit, stdout } from 'node:process'

const examplesPath = argv[2]
if (!examplesPath) {
  stdout.write('usage: node tools/examples-through-server.mjs <examples.json>\n')
  exit(2)
}

const { analyzeCarve } = await import('../dist/analyze.js')
const { semanticTokens } = await import('../dist/semantic.js')

const { examples } = JSON.parse(readFileSync(examplesPath, 'utf8'))
const inputs = examples.filter((example) => typeof example.input === 'string')
if (inputs.length === 0) {
  stdout.write(`examples-through-server: ${examplesPath} states no example input; this is a wiring problem.\n`)
  exit(1)
}

let tokens = 0
let diagnostics = 0
const failures = []
for (const { id, input } of inputs) {
  try {
    diagnostics += analyzeCarve(input).diagnostics.length
    tokens += semanticTokens(input).length
  } catch (error) {
    failures.push(`${id}: ${error instanceof Error ? error.message : String(error)}`)
  }
}

for (const failure of failures) stdout.write(`threw: ${failure}\n`)
stdout.write(`documents=${inputs.length}\nthrew=${failures.length}\ntokens=${tokens}\ndiagnostics=${diagnostics}\n`)
if (failures.length > 0) {
  stdout.write(`::error::the server threw on ${failures.length} of ${inputs.length} spec examples\n`)
  exit(1)
}
