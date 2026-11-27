// Diagnostics benchmark for #670: user-space instructions of the built server
// over stdio, for one open document and 20 one-character edits.
//
// Usage: node tools/bench-edits.mjs [--sizes 2,8,32,270] [--modes push,pull]
//                                   [--dist <dir>]
// Sizes are KB. Prints one row per size with `instructions:u` per mode,
// counted by `perf stat` around the server process only (startup and open
// included). Exits 2 when perf cannot count instructions:u here.
import { execFileSync, spawn } from 'node:child_process'
import { mkdtempSync, readFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const args = process.argv.slice(2)
const option = (name, fallback) => {
  const at = args.indexOf(name)
  return at < 0 ? fallback : args[at + 1]
}
const sizes = option('--sizes', '2,8,32,270').split(',').map(Number)
const modes = option('--modes', 'push,pull').split(',')
const dist = resolve(option('--dist', fileURLToPath(new URL('../dist', import.meta.url))))
const EDITS = 20
const EDIT_GAP_MS = 60
const QUIET_MS = 1000
const sleep = (ms) => new Promise((done) => setTimeout(done, ms))

try {
  execFileSync('perf', ['stat', '-e', 'instructions:u', '-x,', 'true'], { stdio: 'pipe' })
} catch (error) {
  console.error(`bench:edits needs \`perf stat -e instructions:u\`, which failed here: ${String(error.stderr || error.message).trim()}`)
  console.error('Install perf (linux-tools) and allow user-space counting, e.g. `sysctl kernel.perf_event_paranoid=2`.')
  process.exit(2)
}

const { LspStdioClient } = await import(join(dist, 'lsp-stdio-client.js'))

// One section of ordinary prose, lists, a table, code, links and footnotes.
// `n` keeps ids and footnote labels unique per copy, so the document carries
// no duplicate-declaration diagnostics.
function section(n) {
  return `# Section ${n} {#section-${n}}

This paragraph has *strong* and _emphasized_ text, \`inline code\`, a
[link to the next section](#section-${n + 1}) and a footnote[^note-${n}].
It wraps over a few lines, the way prose in a real document does, so the
parser sees soft breaks as well as words.

## Details for ${n} {#details-${n}}

- First item with a [reference](#section-${n})
- Second item with _emphasis_
  - Nested item ${n}
- Third item

1. Ordered one
2. Ordered two

|= Name |= Qty |= Note |
| alpha | ${n} | first row |
| beta | ${n + 1} | second row |

\`\`\` js
const value${n} = ${n} * 2
\`\`\`

> A quote with *strong* text in section ${n}.

[^note-${n}]: The footnote for section ${n}.

`
}

function documentOf(kb) {
  let text = ''
  for (let n = 0; text.length < kb * 1024; n++) text += section(n)
  return text
}

async function run(text, mode) {
  const out = join(mkdtempSync(join(tmpdir(), 'bench-edits-')), 'perf.csv')
  const server = spawn('perf', ['stat', '-e', 'instructions:u', '-x,', '-o', out, '--', process.execPath, join(dist, 'server.js'), '--stdio'], { stdio: ['pipe', 'pipe', 'ignore'] })
  const exited = new Promise((done) => server.on('exit', done))
  const client = new LspStdioClient(server)
  const pull = mode === 'pull'
  await client.request('initialize', {
    processId: null,
    rootUri: null,
    capabilities: pull ? { textDocument: { diagnostic: {} }, workspace: { diagnostics: { refreshSupport: true } } } : {},
  })
  client.notify('initialized', {})
  const uri = 'file:///bench/edits.crv'
  const published = () => client.notifications.filter((item) => item.method === 'textDocument/publishDiagnostics' && item.params.uri === uri).length
  client.notify('textDocument/didOpen', { textDocument: { uri, languageId: 'carve', version: 1, text } })
  if (pull) await client.request('textDocument/diagnostic', { textDocument: { uri } })
  else while (published() === 0) await sleep(5)

  const line = Math.floor(text.split('\n').length / 2)
  const pulls = []
  let seen = 0
  for (let version = 2; version < 2 + EDITS; version++) {
    client.notify('textDocument/didChange', {
      textDocument: { uri, version },
      contentChanges: [{ range: { start: { line, character: 0 }, end: { line, character: 0 } }, text: 'x' }],
    })
    seen = published()
    if (pull) pulls.push(client.request('textDocument/diagnostic', { textDocument: { uri } }).catch(() => null))
    await sleep(EDIT_GAP_MS)
  }
  if (pull) await Promise.all(pulls)
  else {
    // Publishes carry no version, so an earlier edit's report can land after
    // the last edit: wait until reports stop for longer than one debounce plus
    // one analysis of the largest size.
    while (published() <= seen) await sleep(2)
    for (let count = published(); ; count = published()) {
      await sleep(QUIET_MS)
      if (published() === count) break
    }
  }

  await client.request('shutdown', null)
  client.notify('exit', null)
  await exited
  const row = readFileSync(out, 'utf8').split('\n').find((entry) => entry.includes('instructions:u'))
  const count = Number(row?.split(',')[0])
  if (!Number.isFinite(count)) throw new Error(`perf wrote no instructions:u count: ${row}`)
  return count
}

const giga = (count) => `${(count / 1e9).toFixed(2)} G`
console.log(`| Input | ${modes.map((mode) => `${mode} instructions:u`).join(' | ')} |`)
console.log(`|---:|${modes.map(() => '---:').join('|')}|`)
for (const kb of sizes) {
  const text = documentOf(kb)
  const cells = []
  for (const mode of modes) cells.push(giga(await run(text, mode)))
  console.log(`| ${kb} KB | ${cells.join(' | ')} |`)
}
