import assert from 'node:assert/strict'
import test from 'node:test'
import { previewHtml, previewMarkdown } from './preview.js'
import { mergeCarveSettings, readCarveSettings } from './settings.js'

test('render.headingShift reads a count from 0 to 5 (C2-H-208)', () => {
  assert.equal(readCarveSettings({ carve: { render: { headingShift: 2 } } }).headingShift, 2)
  assert.equal(readCarveSettings({ carve: { 'render.headingShift': 5 } }).headingShift, 5)
  for (const value of [0, 6, -1, 1.5, '2', null]) {
    assert.equal(readCarveSettings({ carve: { render: { headingShift: value } } }).headingShift, undefined, String(value))
  }
  assert.equal(mergeCarveSettings({ 'render.headingShift': 1 }, { render: { headingShift: 3 } }).headingShift, 1)
  assert.equal(mergeCarveSettings(undefined, { render: { headingShift: 3 } }).headingShift, 3)
})

test('the preview and the Markdown export move headings down by the shift', () => {
  const source = '# Title\n\n## Part\n'
  assert.match(previewHtml(source), /<h1>Title<\/h1>/)
  assert.match(previewHtml(source, undefined, 2), /<h3>Title<\/h3>[\s\S]*<h4>Part<\/h4>/)
  assert.equal(previewMarkdown(source), '# Title\n\n## Part\n')
  assert.equal(previewMarkdown(source, undefined, 1), '## Title\n\n### Part\n')
})
