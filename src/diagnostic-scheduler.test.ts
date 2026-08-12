import assert from 'node:assert/strict'
import test from 'node:test'
import { DiagnosticScheduler, DEFAULT_DIAGNOSTIC_DELAY_MS } from './diagnostic-scheduler.js'

test('runs once for a burst of edits, not once per edit', (t) => {
  t.mock.timers.enable({ apis: ['setTimeout'] })
  const runs: Array<[string, number]> = []
  const scheduler = new DiagnosticScheduler({ delayMs: 100, run: (u, v) => runs.push([u, v]) })

  for (let version = 1; version <= 10; version++) scheduler.schedule('file:///a', version)
  assert.deepEqual(runs, [])

  t.mock.timers.tick(100)
  assert.deepEqual(runs, [['file:///a', 10]])
})

// The reason a queued run is REPLACED rather than left to fire: it would
// otherwise publish diagnostics computed for text the author has changed.
test('carries the newest version, never a superseded one', (t) => {
  t.mock.timers.enable({ apis: ['setTimeout'] })
  const runs: Array<number> = []
  const scheduler = new DiagnosticScheduler({ delayMs: 100, run: (_u, v) => runs.push(v) })

  scheduler.schedule('file:///a', 1)
  t.mock.timers.tick(90)
  scheduler.schedule('file:///a', 2)
  t.mock.timers.tick(90)
  scheduler.schedule('file:///a', 3)
  t.mock.timers.tick(100)

  assert.deepEqual(runs, [3])
})

test('keeps documents independent', (t) => {
  t.mock.timers.enable({ apis: ['setTimeout'] })
  const runs: Array<string> = []
  const scheduler = new DiagnosticScheduler({ delayMs: 100, run: (u) => runs.push(u) })

  scheduler.schedule('file:///a', 1)
  scheduler.schedule('file:///b', 7)
  t.mock.timers.tick(100)

  assert.deepEqual(runs.sort(), ['file:///a', 'file:///b'])
})

test('cancels a queued run so a closed document publishes nothing', (t) => {
  t.mock.timers.enable({ apis: ['setTimeout'] })
  const runs: Array<string> = []
  const scheduler = new DiagnosticScheduler({ delayMs: 100, run: (u) => runs.push(u) })

  scheduler.schedule('file:///a', 1)
  assert.equal(scheduler.pending('file:///a'), true)
  scheduler.cancel('file:///a')
  t.mock.timers.tick(1000)

  assert.deepEqual(runs, [])
  assert.equal(scheduler.pending('file:///a'), false)
})

test('flushes immediately and drops the queued run', (t) => {
  t.mock.timers.enable({ apis: ['setTimeout'] })
  const runs: Array<number> = []
  const scheduler = new DiagnosticScheduler({ delayMs: 100, run: (_u, v) => runs.push(v) })

  scheduler.schedule('file:///a', 1)
  scheduler.flush('file:///a', 2)
  assert.deepEqual(runs, [2])

  t.mock.timers.tick(1000)
  assert.deepEqual(runs, [2])
})

test('drops everything on dispose', (t) => {
  t.mock.timers.enable({ apis: ['setTimeout'] })
  const runs: Array<string> = []
  const scheduler = new DiagnosticScheduler({ delayMs: 100, run: (u) => runs.push(u) })

  scheduler.schedule('file:///a', 1)
  scheduler.schedule('file:///b', 1)
  scheduler.dispose()
  t.mock.timers.tick(1000)

  assert.deepEqual(runs, [])
})

// BOUND, not proof: the default is exported so a host can reason about it, and
// this pins that it sits in the interactive range. No mutation of the
// coalescing logic breaks this row.
test('defaults to a delay inside the interactive range', () => {
  assert.ok(DEFAULT_DIAGNOSTIC_DELAY_MS >= 100)
  assert.ok(DEFAULT_DIAGNOSTIC_DELAY_MS <= 150)
})
