import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { DEFAULT_CARVE_SETTINGS, mergeCarveSettings, readCarveSettings, readProjectSettings } from './settings.js'

test('reads safe project settings and rejects unknown platform names', () => {
  assert.deepEqual(readCarveSettings(undefined), DEFAULT_CARVE_SETTINGS)
  assert.deepEqual(readCarveSettings({ carve: {
    platforms: ['github', 'unknown'], extensions: ['semantic-span'], inlayHints: false, exportActions: false, formatter: 'migration',
    severities: { 'table-width-total': 'error', bogus: 'loud' },
  } }), {
    platforms: ['github'], extensions: ['semantic-span'], inlayHints: false, bareListMarkerHints: false, exportActions: false, formatter: 'migration', formatAlignTables: false,
    severities: { 'table-width-total': 'error' },
  })
})

test('reads the optional table alignment setting', () => {
  assert.equal(readCarveSettings({ carve: { format: { alignTables: true } } }).formatAlignTables, true)
  assert.equal(readCarveSettings({ carve: { 'format.alignTables': true } }).formatAlignTables, true)
  assert.equal(readCarveSettings({ carve: { format: { alignTables: 'true' } } }).formatAlignTables, false)
})

test('inlayHints takes a boolean or per-hint switches', () => {
  const read = (inlayHints: unknown) => {
    const { inlayHints: all, bareListMarkerHints } = readCarveSettings({ carve: { inlayHints } })
    return { all, bareListMarkerHints }
  }
  assert.deepEqual(read(true), { all: true, bareListMarkerHints: true })
  assert.deepEqual(read(false), { all: false, bareListMarkerHints: false })
  assert.deepEqual(read(undefined), { all: true, bareListMarkerHints: true })
  assert.deepEqual(read({}), { all: true, bareListMarkerHints: true })
  assert.deepEqual(read({ bareListMarkers: false }), { all: true, bareListMarkerHints: false })
  assert.deepEqual(read({ bareListMarkers: true }), { all: true, bareListMarkerHints: true })
})

test('loads .carverc.json from a workspace root', () => {
  const root = mkdtempSync(path.join(tmpdir(), 'carve-settings-'))
  writeFileSync(path.join(root, '.carverc.json'), JSON.stringify({ carve: { platforms: ['github'] } }))
  assert.deepEqual(readProjectSettings([root])?.platforms, ['github'])
})

test('client keys override .carverc.json key by key, unsent keys fall back to it', () => {
  const project = { platforms: ['github'], formatter: 'migration', format: { alignTables: true } }
  const merged = mergeCarveSettings({ formatter: 'conservative', exportActions: false, includes: { enabled: 'auto' } }, project)
  assert.deepEqual(merged.platforms, ['github'])
  assert.equal(merged.formatAlignTables, true)
  assert.equal(merged.formatter, 'conservative')
  assert.equal(merged.exportActions, false)
  assert.equal(mergeCarveSettings({ format: { alignTables: false } }, project).formatAlignTables, false)
  assert.equal(mergeCarveSettings({ 'format.alignTables': false }, project).formatAlignTables, false)
  assert.equal(mergeCarveSettings({ 'format.alignTables': true }, undefined).formatAlignTables, true)
  assert.deepEqual(mergeCarveSettings(undefined, undefined), DEFAULT_CARVE_SETTINGS)
  assert.deepEqual(
    mergeCarveSettings({ severities: { 'a': 'off' } }, { severities: { 'a': 'error', 'b': 'hint' } }).severities,
    { a: 'off', b: 'hint' },
  )
})
