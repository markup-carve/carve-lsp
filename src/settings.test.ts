import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { DEFAULT_CARVE_SETTINGS, readCarveSettings, readProjectSettings } from './settings.js'

test('reads safe project settings and rejects unknown platform names', () => {
  assert.deepEqual(readCarveSettings(undefined), DEFAULT_CARVE_SETTINGS)
  assert.deepEqual(readCarveSettings({ carve: {
    platforms: ['github', 'unknown'], extensions: ['semantic-span'], inlayHints: false, exportActions: false, formatter: 'migration',
    severities: { 'table-width-total': 'error', bogus: 'loud' },
  } }), {
    platforms: ['github'], extensions: ['semantic-span'], inlayHints: false, bareListMarkerHints: false, exportActions: false, formatter: 'migration',
    severities: { 'table-width-total': 'error' },
  })
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
