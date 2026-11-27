import assert from 'node:assert/strict'
import test from 'node:test'
import { DEFAULT_INCLUDE_SETTINGS } from './include-settings.js'
import { newAnalysisCaches, runAnalysisJob, type AnalysisJob } from './analysis-job.js'
import { AnalysisRunner, SupersededError } from './analysis-runner.js'

const workerUrl = new URL('./analysis-worker.js', import.meta.url)

function job(uri: string, source: string): AnalysisJob {
  return {
    uri,
    source,
    lint: {},
    includeGate: { settings: DEFAULT_INCLUDE_SETTINGS, workspaceTrusted: false, workspaceRoots: [], openDocuments: [] },
  }
}

const SAMPLE = [
  '== Title {#top}',
  '',
  'See [Intro](#intro) and [^note].',
  '',
  '[^note]: A note.',
  '',
  '{#top}',
  'Duplicate id above.',
  '',
  '| a | b |',
  '',
].join('\n')

function bigDocument(bytes: number): string {
  const parts: string[] = []
  let size = 0
  for (let i = 0; size < bytes; i++) {
    const block = `== Section ${i} {#s${i}}\n\nParagraph ${i} with _emphasis_, a [link](#s${Math.max(0, i - 1)}) and a footnote[^n${i}].\n\n[^n${i}]: Note ${i}.\n\n- item one\n- item two\n\n`
    parts.push(block)
    size += block.length
  }
  return parts.join('')
}

test('the worker reports what an inline analysis reports', async () => {
  const runner = new AnalysisRunner({ workerUrl })
  try {
    assert.equal(runner.threaded, true)
    const sources = [SAMPLE, '', 'plain text\n', bigDocument(20_000)]
    for (const [index, source] of sources.entries()) {
      const threaded = await runner.analyze(job(`file:///doc${index}.crv`, source))
      const inline = runAnalysisJob(job(`file:///doc${index}.crv`, source), newAnalysisCaches())
      assert.deepEqual(threaded, JSON.parse(JSON.stringify(inline)))
    }
  } finally {
    runner.dispose()
  }
})

test('a queued job is replaced by a newer one for the same document', async () => {
  const runner = new AnalysisRunner({ workerUrl })
  try {
    const running = runner.analyze(job('file:///a.crv', bigDocument(50_000)))
    const stale = runner.analyze(job('file:///b.crv', 'old {#x}\n\n{#x}\nagain\n'))
    const other = runner.analyze(job('file:///c.crv', SAMPLE))
    const fresh = runner.analyze(job('file:///b.crv', 'new text\n'))
    await assert.rejects(stale, SupersededError)
    await running
    assert.deepEqual((await fresh).diagnostics, [])
    assert.ok((await other).diagnostics.length > 0)
  } finally {
    runner.dispose()
  }
})

test('a missing worker script falls back to analyzing inline', async () => {
  const reasons: string[] = []
  const runner = new AnalysisRunner({
    workerUrl: new URL('./no-such-analysis-worker.js', import.meta.url),
    onFallback: (reason) => reasons.push(reason),
  })
  try {
    assert.equal(runner.threaded, false)
    assert.equal(reasons.length, 1)
    const analysis = await runner.analyze(job('file:///doc.crv', SAMPLE))
    assert.deepEqual(analysis, runAnalysisJob(job('file:///doc.crv', SAMPLE), newAnalysisCaches()))
  } finally {
    runner.dispose()
  }
})

test('the event loop keeps turning while the worker analyzes', async () => {
  const runner = new AnalysisRunner({ workerUrl })
  try {
    await runner.analyze(job('file:///warm.crv', SAMPLE))
    const source = bigDocument(400_000)
    const started = performance.now()
    let last = started
    let longest = 0
    const timer = setInterval(() => {
      const now = performance.now()
      longest = Math.max(longest, now - last)
      last = now
    }, 5)
    await runner.analyze(job('file:///big.crv', source))
    clearInterval(timer)
    const finished = performance.now()
    longest = Math.max(longest, finished - last)
    const elapsed = finished - started
    // Inline, the whole analysis would be one block of `elapsed` ms.
    assert.ok(elapsed > 200, `analysis took ${elapsed.toFixed(0)} ms, too short to show anything`)
    assert.ok(longest < elapsed / 2, `longest block ${longest.toFixed(0)} ms of ${elapsed.toFixed(0)} ms`)
  } finally {
    runner.dispose()
  }
})
