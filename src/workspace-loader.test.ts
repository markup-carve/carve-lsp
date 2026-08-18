import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, mkdirSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { WorkspaceIndex } from './workspace-index.js'
import { indexWorkspace } from './workspace-loader.js'

test('indexes bounded .crv workspace files and ignores dependency directories', () => {
  const root = mkdtempSync(path.join(tmpdir(), 'carve-workspace-'))
  mkdirSync(path.join(root, 'chapters'))
  mkdirSync(path.join(root, 'node_modules'))
  writeFileSync(path.join(root, 'chapters', 'a.crv'), '[^a]: note\n')
  writeFileSync(path.join(root, 'node_modules', 'hidden.crv'), '[^hidden]: no\n')
  const index = new WorkspaceIndex()
  assert.deepEqual(indexWorkspace(index, [root]), { files: 1, bytes: 11, truncated: false })
  assert.equal(index.definitions('footnote', 'a').length, 1)
  assert.equal(index.definitions('footnote', 'hidden').length, 0)
})
