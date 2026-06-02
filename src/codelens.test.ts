import assert from 'node:assert/strict'
import test from 'node:test'
import { codeLenses } from './codelens.js'

test('counts references for each footnote definition', () => {
  const source = 'a[^x] b[^x]\n\n[^x]: defined\n[^y]: orphan'
  const lenses = codeLenses(source)
  const titles = lenses.map((l) => l.command?.title)
  assert.ok(titles.includes('2 references'))
  assert.ok(titles.includes('0 references'))
})

test('uses the singular form for a single reference', () => {
  const lenses = codeLenses('a[^x]\n\n[^x]: defined')
  assert.equal(lenses[0]?.command?.title, '1 reference')
})

test('emits no lenses without footnote definitions', () => {
  assert.deepEqual(codeLenses('just prose with [^ref] but no def line that matches? [^ref]'), [])
})
