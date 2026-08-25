import test from 'node:test'
import assert from 'node:assert/strict'
import { WorkspaceIndex } from './workspace-index.js'
import { backlinks, generatedNavigation, rebuildImpact, workspaceGraph } from './workspace-graph.js'

test('builds semantic, citation, asset, link, and include edges', () => {
  const index = new WorkspaceIndex()
  index.update('file:///ws/a.crv', '{#intro}\n# Introduction\n\n[@doe]: Source\n', 1)
  index.update('file:///ws/b.crv', 'See </#intro> [@doe].\n![Plot](plot.svg)\n[Next](c.crv)\n{{ "a.crv" }}\n', 1)
  index.update('file:///ws/c.crv', '# Next\n', 1)

  const graph = workspaceGraph(index)
  assert.deepEqual(graph.edges.map(({ kind, to }) => ({ kind, to })), [
    { kind: 'reference', to: 'file:///ws/a.crv' },
    { kind: 'citation', to: 'file:///ws/a.crv' },
    { kind: 'asset', to: null },
    { kind: 'document-link', to: 'file:///ws/c.crv' },
    { kind: 'include', to: 'file:///ws/a.crv' },
  ])
  assert.equal(graph.unresolved[0]?.key, 'plot.svg')
  assert.equal(backlinks(index, 'file:///ws/a.crv').length, 3)
})

test('generates navigation and computes transitive rebuild impact', () => {
  const index = new WorkspaceIndex()
  index.update('file:///ws/a.crv', '# Start\n', 1)
  index.update('file:///ws/b.crv', '{{ a.crv }}\n', 1)
  index.update('file:///ws/c.crv', '[B](b.crv)\n', 1)

  assert.deepEqual(generatedNavigation(index), [{
    uri: 'file:///ws/a.crv', id: 'Start', title: 'Start', line: 0,
  }])
  assert.deepEqual(rebuildImpact(index, 'file:///ws/a.crv'), ['file:///ws/b.crv', 'file:///ws/c.crv'])
})
