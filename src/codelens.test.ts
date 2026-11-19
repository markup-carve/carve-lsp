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

test('counts heading, citation, and link-reference usages', () => {
  const source = '{#h}\n# H\n\nSee </#h> and [x][r] [@c].\n\n[r]: /u\n[@c]: Entry\n'
  const titles = codeLenses(source).map((lens) => lens.command?.title)
  // 0.2 C2-I-101: citations have no core form, so `[@c]: Entry` is also a core link
  // definition (key `@c`) that nothing references, beside the citation the text scan reads.
  assert.deepEqual(titles, ['1 reference', '1 reference', '0 references', '1 reference'])
})
