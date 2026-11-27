// Compare the generated 0.2 example IDs with the examples declared in the spec documents.
import { readFileSync } from 'node:fs'
import { join, resolve } from 'node:path'
import { pathToFileURL } from 'node:url'
import { argv, exit, stdout } from 'node:process'

const specRoot = argv[2]
if (!specRoot) {
  stdout.write('usage: node tools/verify-example-population.mjs <carve-checkout>\n')
  exit(2)
}

const { allExamples } = await import(pathToFileURL(resolve(specRoot, 'scripts/lib/spec2-examples.mjs')).href)
const declared = allExamples(join(specRoot, 'spec/0.2')).map(({ document, number }) => `${document}-${number}`)
const shipped = JSON.parse(readFileSync(join(specRoot, 'spec/0.2/conformance/examples.json'), 'utf8'))
  .examples.map(({ id }) => id)
if (declared.length !== shipped.length || declared.some((id, index) => id !== shipped[index])) {
  stdout.write(`0.2 examples differ from the spec documents: ${declared.length} declared, ${shipped.length} shipped\n`)
  exit(1)
}
stdout.write(`verified=${shipped.length}\n`)
