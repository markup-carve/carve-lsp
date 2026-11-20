import test from 'node:test'
import assert from 'node:assert/strict'
import { analyzeCarve } from './analyze.js'
import { previewMarkdown } from './preview.js'
import { sections } from './include-selection.js'

// Features that came back with the `/export` and `/extensions` entries of the engine.

test('Markdown export writes Markdown through the writer registry', () => {
  assert.match(previewMarkdown('= Title\n\n/em/ and *strong*\n'), /^# Title\n\n\*em\* and \*\*strong\*\*/)
})

test('the semantic-span lint extension covers samp, var, cite and dfn', () => {
  const codes = analyzeCarve('{samp}\nOutput text.\n', { lint: { extensions: ['semantic-span'] } }).diagnostics.map((d) => d.code)
  assert.ok(codes.includes('semantic-attribute-outside-span'))
})

test('without the semantic-span lint extension samp is not a semantic key', () => {
  const codes = analyzeCarve('{samp}\nOutput text.\n').diagnostics.map((d) => d.code)
  assert.ok(!codes.includes('semantic-attribute-outside-span'))
})

// Ported calls: the 0.2 shapes the server reads.

test('a severity for an unknown rule keeps the valid opt-in rules beside it', () => {
  const codes = analyzeCarve('+ item\n', { lint: { severities: { 'djot-plus-bullet': 'warning', bogus: 'off' } } }).diagnostics.map((d) => d.code)
  assert.deepEqual(codes, ['djot-plus-bullet'])
})

test('a section heading with an attribute line is found on its own line (C2-A-148)', () => {
  assert.deepEqual(sections('Lead.\n\n{#x}\n# Hello\n').map((section) => [section.id, section.range.start.line]), [['x', 3]])
})
