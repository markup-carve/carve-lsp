import test from 'node:test'
import assert from 'node:assert/strict'
import { parse } from './engine.js'
import { walkNodes, type AstNode } from './ast-walk.js'

const headings = (source: string) => {
  const found: string[] = []
  walkNodes(parse(source, { positions: true }), (node, ancestors) => {
    if (node.type === 'heading') found.push(`${node.pos?.startLine}:${ancestors.map((a) => a.type).join('>')}`)
  })
  return found
}

test('reaches headings in list items, descriptions and footnote bodies', () => {
  assert.deepEqual(headings('- item\n\n  ## In list\n'), ['3:document>list>list_item'])
  // 0.2 C2-A-062: a description is a `definition_description` node that holds the blocks.
  assert.deepEqual(headings(':: term\n: def\n\n  ## In def\n'), ['4:document>definition_list>definition_description'])
  assert.deepEqual(headings('x[^1]\n\n[^1]: note\n\n    ## In note\n').length, 1)
})

test('a false return skips the subtree', () => {
  const seen: string[] = []
  walkNodes(parse('> # Quoted\n'), (node: AstNode) => { seen.push(String(node.type)); return node.type !== 'block_quote' })
  assert.deepEqual(seen, ['document', 'block_quote'])
})
