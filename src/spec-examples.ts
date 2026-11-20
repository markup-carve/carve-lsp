/**
 * The inputs of the 0.2 conformance examples in the pinned spec
 * (`spec/0.2/conformance/examples.json`), for gates that run over every
 * document the spec states. They replace the 0.1 corpus, which carve `next2`
 * no longer carries. Test-only.
 */
import { readFileSync } from 'node:fs'

interface Example {
  id: string
  input?: unknown
}

export function specDocuments(): Array<{ name: string; source: string }> {
  const file = new URL('../tests/spec/spec/0.2/conformance/examples.json', import.meta.url)
  const { examples } = JSON.parse(readFileSync(file, 'utf8')) as { examples: Example[] }
  return examples
    .filter((example): example is Example & { input: string } => typeof example.input === 'string')
    .map((example) => ({ name: example.id, source: example.input }))
}
