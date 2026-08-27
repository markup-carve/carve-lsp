import assert from 'node:assert/strict'
import { readdirSync, readFileSync } from 'node:fs'
import test from 'node:test'
import { fileURLToPath } from 'node:url'
import { parse } from '@markup-carve/carve'
import { colonFenceHighlights, colonFenceOpeners, colonFenceStructure } from './colon-fences.js'

/**
 * WHY THIS FILE EXISTS (#157). `colonFenceStructure` used to name the colon-fence
 * node types in a hand-written chain, and returned `null` for anything the chain
 * did not name. A missing kind is therefore invisible rather than loud: no
 * opener/closer pair, no highlight, no length-mismatch diagnostic, and no failing
 * test - the container simply is not there.
 *
 * Two kinds had already fallen through it. The fenced block quote (carve#1718) is
 * not a node type at all - it is a `block_quote` carrying `fenced: true` - and
 * `figure_group` (carve#1122) was never added when composite figures shipped. So
 * the gate below is written against the CORPUS rather than against a list this
 * repo maintains: it reads what a `:::` line does from the parser and the source,
 * and a seventh kind fails it on arrival instead of being skipped.
 */

const corpusDir = fileURLToPath(new URL('../tests/spec/tests/corpus/', import.meta.url))

/**
 * Types that can legitimately START on a `:::` run without being a fence: prose
 * the parser folded a literal `:::` line into, and the nodes it reads verbatim.
 * The gate is written as this inversion on purpose - a NEW container type is not
 * on it, so it is expected by default rather than having to be remembered.
 */
const NOT_A_FENCE = new Set(['text', 'paragraph', 'code', 'code_block', 'raw_block', 'raw_inline', 'literal_inline', 'comment'])

/**
 * The independent reading of "a colon fence is here": any node in the parsed
 * document whose start position lands on a `:::` run and which is not one of the
 * above. No fence type is named, no `children` is required, and the walk starts at
 * the document rather than at its `children` - so a kind that is not a type of its
 * own, a kind carrying no children, and a container hanging off a field other
 * than `children` each fail this gate rather than disappearing.
 */
function fenceLinesInAst(source: string): number[] {
  const lines = source.replace(/\r\n?/g, '\n').split('\n')
  const found = new Set<number>()
  const walk = (value: unknown): void => {
    if (Array.isArray(value)) { for (const child of value) walk(child); return }
    if (!value || typeof value !== 'object') return
    const node = value as Record<string, unknown>
    const pos = node.pos as { startLine?: number; startColumn?: number } | undefined
    if (node.type && !NOT_A_FENCE.has(String(node.type)) && pos?.startLine && pos.startColumn && /^:{3,}/.test((lines[pos.startLine - 1] ?? '').slice(pos.startColumn - 1))) {
      found.add(pos.startLine - 1)
    }
    for (const [name, child] of Object.entries(node)) if (name !== 'pos' && name !== 'attrs') walk(child)
  }
  walk(parse(source, { positions: true }))
  return [...found].sort((a, b) => a - b)
}

test('every colon fence in the corpus is a container the server recognizes', () => {
  const documents = readdirSync(corpusDir).filter((name) => name.endsWith('.crv')).sort()
  assert.ok(documents.length > 0, 'the colon-fence gate found no corpus documents')

  const missed: string[] = []
  const kinds = new Set<string>()
  let checked = 0
  for (const name of documents) {
    const source = readFileSync(`${corpusDir}/${name}`, 'utf8')
    const expected = fenceLinesInAst(source)
    if (expected.length === 0) continue
    const sites = new Map(colonFenceOpeners(source).map((site) => [site.range.start.line, site]))
    for (const line of expected) {
      checked += 1
      const site = sites.get(line)
      if (site) kinds.add(site.kind)
      else missed.push(`${name}:${line + 1}`)
    }
  }
  assert.ok(checked > 0, 'the corpus contains no colon fences, so this gate proved nothing')
  assert.deepEqual(missed, [], `colon fences the server does not see (a node type it cannot name?): ${missed.join(', ')}`)
  // The gate is only worth its runtime while the corpus still spells the kinds
  // that fell through the old chain, so it says so rather than assuming it.
  for (const kind of ['block quote', 'figure group']) {
    assert.ok(kinds.has(kind), `the corpus no longer exercises a ${kind} colon fence, so this gate stopped covering it`)
  }
})

test('a fenced block quote pairs, and the marker spelling has nothing to pair', () => {
  // Both directions on the shape #157 is about: only the fenced spelling has
  // fences, so only it produces a pair - reporting one for `> x` would be the
  // over-broad fix.
  const fenced = colonFenceStructure('::: >\nquoted\n:::\n')
  assert.deepEqual(fenced.pairs.map(({ opener, closer }) => [opener.kind, opener.range.start.line, closer.range.start.line]), [['block quote', 0, 2]])
  assert.deepEqual(colonFenceStructure('> quoted\n').pairs, [])
})

test('putting the cursor on either fence of a block quote highlights both', () => {
  const source = '::: >\nquoted\n:::\n'
  for (const position of [{ line: 0, character: 1 }, { line: 2, character: 1 }]) {
    assert.deepEqual(colonFenceHighlights(source, position).map((h) => h.range.start.line), [0, 2], JSON.stringify(position))
  }
})

test('the length-mismatch diagnostic fires inside a fenced block quote', () => {
  // The container has to become a `parent` in the walk for this to be reachable
  // at all; while the quote was skipped, no diagnostic could be raised inside one.
  const [found] = colonFenceStructure(':::: >\nquoted\n:::\n').diagnostics
  assert.equal(found?.code, 'colon-fence-length-mismatch')
  assert.deepEqual(found?.data, { authoredWidth: 3, expectedWidth: 4, openerLine: 1, openerColumn: 1, outcome: 'nested container' })
})

test('a composite figure pairs too', () => {
  // The kind that was already missing before the one #157 was filed for.
  assert.deepEqual(colonFenceStructure('::: figure\n![a](a.png)\n\n![b](b.png)\n:::\n^ Two panels\n').pairs
    .map(({ opener, closer }) => [opener.kind, opener.range.start.line, closer.range.start.line]), [['figure group', 0, 4]])
})

test('a closer is found whether or not the extent spans it', () => {
  // A div spans its closing fence and a fenced quote does not, so pairing off
  // `pos.end` read the wrong line for one of them. Here the quote's extent ends
  // ON the inner div's closer.
  assert.deepEqual(colonFenceStructure('::: >\n::: note\nx\n:::\n:::\n').pairs
    .map(({ opener, closer }) => [opener.kind, opener.range.start.line, closer.range.start.line])
    .sort((a, b) => Number(a[1]) - Number(b[1])), [['block quote', 0, 4], ['note admonition', 1, 3]])
})

test('a bare fence inside a verbatim block closes nothing', () => {
  for (const source of [':::: >\n```\n::::\n```\n::::\n', ':::: >\n%%%\n::::\n%%%\n::::\n']) {
    assert.deepEqual(colonFenceStructure(source).pairs.map(({ closer }) => closer.range.start.line), [4], source)
  }
})
