import test from 'node:test'
import assert from 'node:assert/strict'
import { WorkspaceIndex, scanDocument } from './workspace-index.js'

test('indexes declarations and uses across Carve namespaces', () => {
  const tokens = scanDocument('file:///a.crv', '{#intro}\n# Intro\n\nSee </#intro> and [^n].\n\n[^n]: note\n')
  assert.deepEqual(tokens.map(({ kind, key, declaration }) => ({ kind, key, declaration })), [
    { kind: 'heading', key: 'intro', declaration: true },
    { kind: 'heading', key: 'intro', declaration: false },
    { kind: 'footnote', key: 'n', declaration: false },
    { kind: 'footnote', key: 'n', declaration: true },
  ])
})

test('finds references and renames headings across indexed documents', () => {
  const index = new WorkspaceIndex()
  index.update('file:///a.crv', '{#note}\n# Note\n', 1)
  index.update('file:///b.crv', 'Use </#note>.\n', 1)
  assert.equal(index.references('heading', 'note', true).length, 2)
  const edit = index.rename('file:///b.crv', { line: 0, character: 8 }, 'source')
  assert.deepEqual(Object.keys(edit?.changes ?? {}).sort(), ['file:///a.crv', 'file:///b.crv'])
})

test('versioned updates replace stale tokens and removal clears them', () => {
  const index = new WorkspaceIndex()
  index.update('file:///a.crv', '[^old]: body\n', 1)
  index.update('file:///a.crv', '[^new]: body\n', 2)
  assert.equal(index.definitions('footnote', 'old').length, 0)
  assert.equal(index.definitions('footnote', 'new').length, 1)
  index.remove('file:///a.crv')
  assert.equal(index.tokens().length, 0)
})

test('indexes generated heading ids and materializes an explicit id when renamed', () => {
  const index = new WorkspaceIndex()
  index.update('file:///a.crv', '# Hello *World*\n', 1)
  index.update('file:///b.crv', 'See </#Hello-World>.\n', 1)

  assert.equal(index.definitions('heading', 'Hello-World')[0]?.label, 'Hello World')
  assert.deepEqual(index.rename('file:///b.crv', { line: 0, character: 9 }, 'greeting'), {
    changes: {
      'file:///a.crv': [{
        range: { start: { line: 0, character: 0 }, end: { line: 0, character: 0 } },
        newText: '{#greeting}\n',
      }],
      'file:///b.crv': [{
        range: { start: { line: 0, character: 7 }, end: { line: 0, character: 18 } },
        newText: 'greeting',
      }],
    },
  })
})

test('headings and captions share the document anchor namespace', () => {
  const index = new WorkspaceIndex()
  index.update('file:///a.crv', '{#plot}\n![Plot](plot.svg)\n', 1)
  index.update('file:///b.crv', 'See </#plot>.\n', 1)
  assert.equal(index.definitions('heading', 'plot')[0]?.kind, 'caption')
})

test('reports workspace-wide dead references and duplicate declarations', () => {
  const index = new WorkspaceIndex()
  index.update('file:///a.crv', '{#same}\n# A\n', 1)
  index.update('file:///b.crv', '{#same}\n# B\n\nSee </#missing>.\n', 1)
  const diagnostics = index.diagnostics('file:///b.crv')
  assert.deepEqual(diagnostics.map(({ code }) => code), [
    'workspace-duplicate-heading',
    'workspace-unresolved-heading',
  ])
  assert.equal(diagnostics[0]?.relatedInformation?.[0]?.location.uri, 'file:///a.crv')
})

test('every change bumps the generation and wakes a waiting listener once', () => {
  const index = new WorkspaceIndex()
  let woken = 0
  index.onceChanged(() => { woken += 1 })
  const before = index.generation
  index.update('file:///a.crv', '# A', 1)
  index.update('file:///a.crv', '# A', 1)
  assert.equal(index.generation, before + 1, 'an identical update is not a change')
  assert.equal(woken, 1)
  index.remove('file:///missing.crv')
  assert.equal(index.generation, before + 1, 'removing an unknown uri is not a change')
  const stop = index.onceChanged(() => { woken += 1 })
  stop()
  index.remove('file:///a.crv')
  assert.equal(index.generation, before + 2)
  assert.equal(woken, 1, 'a cancelled listener is not called')
})
