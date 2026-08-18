import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { includeCompletions } from './include-completion.js'

test('completes contained files and their heading fragments', () => {
  const root = mkdtempSync(path.join(tmpdir(), 'carve-include-complete-'))
  const sourcePath = path.join(root, 'main.crv')
  writeFileSync(path.join(root, 'chapter.crv'), '# First section\n')
  const options = { sourcePath, includeRoot: root }
  assert.deepEqual(includeCompletions('{{ cha', { line: 0, character: 6 }, options).map((item) => item.label), ['chapter.crv'])
  assert.deepEqual(includeCompletions('{{ chapter.crv#Fir', { line: 0, character: 18 }, options).map((item) => item.label), ['First-section'])
})
