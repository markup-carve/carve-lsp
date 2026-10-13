import test from 'node:test'
import assert from 'node:assert/strict'
import { completionAt } from './completion.js'

// The attribute completion replaces what was typed of the attribute, not just the cursor.
function replaced(prefix: string): { from: number; labels: string[] } {
  const items = completionAt(prefix, { line: 0, character: prefix.length })
  const edit = items[0]?.textEdit
  assert.ok(edit && 'range' in edit, `${prefix}: items carry a text edit`)
  return { from: edit.range.start.character, labels: items.map((item) => item.label) }
}

test('an attribute completion replaces the typed token', () => {
  for (const [prefix, token] of [['{al', 'al'], ['{.cl', '.cl'], ['{#i', '#i'], ['x {.a al', 'al'], ['{.a #', '#'], ['{', '']] as const) {
    const { from, labels } = replaced(prefix)
    assert.equal(prefix.slice(from), token, prefix)
    assert.ok(labels.includes('align='), prefix)
  }
})
