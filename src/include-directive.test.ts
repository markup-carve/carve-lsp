import assert from 'node:assert/strict'
import test from 'node:test'
import { findDirectives, parseDirective, verbatimSpans } from './include-directive.js'

// Expectations here follow the cross-engine include-conformance vectors named
// in each test (markup-carve/carve tests/include-conformance/vectors). Those
// vectors currently live only on the unmerged spec branch for
// markup-carve/carve#291, so they are cited rather than vendored.

test('a bare directive is recognized with its path', () => {
  const [d] = findDirectives('{{ child.crv }}')
  assert.ok(d)
  assert.equal(d.path, 'child.crv')
  assert.equal(d.start, 0)
  assert.equal(d.end, 15)
})

test('a quoted path carrying a space is recognized (i01-quoted-path-roundtrip)', () => {
  const [d] = findDirectives('{{ "my chapter.crv" }}')
  assert.ok(d)
  assert.equal(d.path, 'my chapter.crv')
})

test('a section selector is separated from the path', () => {
  const [d] = findDirectives('{{ c.crv #Intro }}')
  assert.ok(d)
  assert.equal(d.path, 'c.crv')
  assert.equal(d.section, 'Intro')
})

test('empty and pathless brace pairs stay literal (i01-*-literal)', () => {
  // Each of these is ordinary text under the PART 6 production: the path token
  // is mandatory and may not begin with `#` or `@`.
  for (const source of ['{{}}', '{{   }}', '{{ #sec }}', '{{ @shift:1 }}']) {
    assert.deepEqual(findDirectives(source), [], source)
  }
})

test('an unknown option makes the directive literal and reports the option (i01-unknown-option-literal)', () => {
  const seen: string[] = []
  const found = findDirectives('{{ child @nope:1 }}', (part) => seen.push(part))
  assert.deepEqual(found, [])
  assert.deepEqual(seen, ['@nope:1'])
})

test('a malformed shift value is an unknown option (i01-shift-malformed-value)', () => {
  const seen: string[] = []
  assert.deepEqual(findDirectives('{{ child @shift:x }}', (part) => seen.push(part)), [])
  assert.deepEqual(seen, ['@shift:x'])
})

test('several directives in one run are all found (i09a-multi-directive-one-run)', () => {
  const found = findDirectives('start {{ a.crv }} mid {{ b.crv }} end')
  assert.deepEqual(
    found.map((d) => d.path),
    ['a.crv', 'b.crv'],
  )
})

test('adjacent directives are both found', () => {
  const found = findDirectives('{{ a.crv }}{{ d.crv }}')
  assert.deepEqual(
    found.map((d) => d.path),
    ['a.crv', 'd.crv'],
  )
})

// ---------------------------------------------------------------------------
// Verbatim shielding (I9)
// ---------------------------------------------------------------------------

test('a directive inside a fence or a code span is shielded (i09-verbatim-fence-and-code-span)', () => {
  const source = '```txt\n{{ child }}\n```\n\nUse `{{ child }}`.'
  assert.deepEqual(findDirectives(source), [])
})

test('a raw block shields its directive (i09-verbatim-raw-block)', () => {
  assert.deepEqual(findDirectives('```=html\n{{ child }}\n```'), [])
})

test('a fence shields only itself; a directive after it still resolves (i09-fence-info-shields-plain-expands)', () => {
  const source = '```js\n{{ child }}\n```\n\n{{ child }}'
  const found = findDirectives(source)
  assert.equal(found.length, 1)
  // The surviving one is the directive AFTER the closing fence.
  assert.equal(found[0]!.start, source.lastIndexOf('{{ child }}'))
})

test('a tilde fence shields too', () => {
  assert.deepEqual(findDirectives('~~~\n{{ child }}\n~~~'), [])
})

test('an unterminated fence shields to the end of the document', () => {
  assert.deepEqual(findDirectives('```\n{{ child }}\n'), [])
})

test('verbatimSpans covers the whole fence including its markers', () => {
  const source = '```\nx\n```\n'
  assert.deepEqual(verbatimSpans(source), [{ start: 0, end: 9 }])
})

test('parseDirective rejects a token that is not a directive', () => {
  assert.equal(parseDirective('{{ oops'), null)
  assert.equal(parseDirective('{{ }}'), null)
})
