#!/usr/bin/env node
// Diagnostics cost on large documents (markup-carve/carve-lsp#670): how long
// one analysis takes, how long a pulling client waits after a typing burst,
// and how long the server's event loop stays blocked meanwhile.
//
// Usage: npm run build && node tools/bench-analysis.mjs [--seed <dir or .crv files>...]
//          [--sizes 100,270,1000] [--samples 20] [--keystrokes 20] [--dist <dir>] [--json]
//
// The seed defaults to the .crv files of the tests/spec submodule. The first 20
// (by path) are repeated to each size, once with ids and footnote labels made
// unique per copy and once with them left duplicated. A tracked number, not a
// CI gate: wall-clock time depends on the machine. `--dist` measures another
// build (say, one of origin/main) with the same inputs.
import { readdirSync, readFileSync, statSync } from 'node:fs'
import path from 'node:path'
import { performance } from 'node:perf_hooks'
import { fileURLToPath, pathToFileURL } from 'node:url'

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const distAt = process.argv.indexOf('--dist')
const dist = path.resolve(distAt === -1 ? path.join(root, 'dist') : process.argv[distAt + 1])
const { analyzeCarve } = await import(pathToFileURL(path.join(dist, 'analyze.js')).href)
const { LspStdioClient } = await import(pathToFileURL(path.join(dist, 'lsp-stdio-client.js')).href)

const args = process.argv.slice(2)
const option = (name, fallback) => {
  const at = args.indexOf(name)
  return at === -1 ? fallback : args[at + 1]
}
const seedArgs = []
for (let i = 0; i < args.length; i++) {
  if (args[i] === '--seed') while (args[i + 1] && !args[i + 1].startsWith('--')) seedArgs.push(args[++i])
}
const sizes = option('--sizes', '100,270,1000').split(',').map(Number)
const samples = Number(option('--samples', '20'))
const keystrokes = Number(option('--keystrokes', '20'))
const json = args.includes('--json')

function crvFiles(target) {
  if (statSync(target).isFile()) return [target]
  return readdirSync(target, { withFileTypes: true }).flatMap((entry) => {
    if (entry.name.startsWith('.') || entry.name === 'node_modules') return []
    const full = path.join(target, entry.name)
    return entry.isDirectory() ? crvFiles(full) : entry.name.endsWith('.crv') ? [full] : []
  })
}

const seedFiles = (seedArgs.length ? seedArgs : [path.join(root, 'tests/spec')])
  .flatMap((target) => { try { return crvFiles(target) } catch { return [] } })
  .sort()
  .slice(0, 20)
if (seedFiles.length === 0) {
  console.error('No .crv seed files: run `git submodule update --init tests/spec` or pass --seed <dir>.')
  process.exit(2)
}
const seed = seedFiles.map((file) => readFileSync(file, 'utf8')).join('\n\n')

function documentOf(kb, unique) {
  let text = ''
  for (let copy = 1; text.length < kb * 1024; copy++) {
    text += (unique
      ? seed.replace(/(\{[^}\n]*#)([^\s}]+)/g, `$1$2-${copy}`).replace(/\[\^([^\]]+)\]/g, `[^$1-${copy}]`)
      : seed) + '\n\n'
  }
  return text
}

const percentile = (sorted, p) => sorted[Math.min(sorted.length - 1, Math.floor(sorted.length * p))]

function benchAnalyze(text) {
  const times = []
  let diagnostics = 0
  for (let i = 0; i < samples + 5; i++) {
    const at = Math.floor(text.length * ((i % 5) / 5))
    const edited = text.slice(0, at) + 'x' + text.slice(at)
    const started = performance.now()
    diagnostics = analyzeCarve(edited, { uri: 'file:///bench.crv' }).diagnostics.length
    if (i >= 5) times.push(performance.now() - started)
  }
  times.sort((a, b) => a - b)
  return { median: percentile(times, 0.5), p95: percentile(times, 0.95), diagnostics }
}

// A typing burst from a client that pulls on every change and cancels the
// previous pull, as vscode-languageclient does. An unknown request is answered
// by the JSON-RPC layer at once, so its round trip is how long the event loop
// was blocked.
async function benchServer(text) {
  const client = LspStdioClient.spawnServer(path.join(dist, 'server.js'))
  try {
    await client.request('initialize', {
      processId: null,
      capabilities: { textDocument: { diagnostic: {} }, workspace: { diagnostics: { refreshSupport: true } } },
      workspaceFolders: [],
    })
    client.notify('initialized', {})
    const uri = 'file:///bench.crv'
    client.notify('textDocument/didOpen', { textDocument: { uri, languageId: 'carve', version: 1, text } })
    await client.request('textDocument/diagnostic', { textDocument: { uri } })

    let probing = true
    let longestBlock = 0
    const probe = (async () => {
      while (probing) {
        const sent = performance.now()
        await client.request('carve/benchPing', null).catch(() => {})
        longestBlock = Math.max(longestBlock, performance.now() - sent)
        await new Promise((resolve) => setTimeout(resolve, 10))
      }
    })()

    let pull
    let pullId
    let answered = 0
    let lastAnswer = 0
    for (let version = 2; version <= keystrokes + 1; version++) {
      client.notify('textDocument/didChange', {
        textDocument: { uri, version },
        contentChanges: [{ range: { start: { line: 10, character: 0 }, end: { line: 10, character: 0 } }, text: 'x' }],
      })
      if (pull) client.notify('$/cancelRequest', { id: pullId })
      pullId = client.nextId
      pull = client.request('textDocument/diagnostic', { textDocument: { uri } })
        .then(() => { answered++; lastAnswer = performance.now() }, () => {})
      await new Promise((resolve) => setTimeout(resolve, 40))
    }
    const typed = performance.now()
    await pull
    probing = false
    await probe
    return { afterLastKeystroke: lastAnswer - typed, pullsAnswered: answered, longestBlock }
  } finally {
    await client.stop()
  }
}

const rows = []
for (const kb of sizes) {
  for (const unique of [true, false]) {
    const text = documentOf(kb, unique)
    const analysis = benchAnalyze(text)
    const server = await benchServer(text)
    const row = { kb, ids: unique ? 'unique' : 'duplicated', ...analysis, ...server }
    rows.push(row)
    if (!json) {
      console.log(`${kb} KB, ${row.ids} ids: analyzeCarve median ${analysis.median.toFixed(0)} ms, p95 ${analysis.p95.toFixed(0)} ms, ${analysis.diagnostics} diagnostics; `
        + `burst of ${keystrokes}: last pull ${server.afterLastKeystroke.toFixed(0)} ms after the last keystroke, `
        + `${server.pullsAnswered} answered, longest event-loop block ${server.longestBlock.toFixed(0)} ms`)
    }
  }
}
if (json) console.log(JSON.stringify({ seedFiles: seedFiles.map((file) => path.relative(root, file)), samples, keystrokes, rows }, null, 2))
