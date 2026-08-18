import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { DEFAULT_CARVE_SETTINGS, readCarveSettings, readProjectSettings } from './settings.js'

test('reads safe project settings and rejects unknown platform names', () => {
  assert.deepEqual(readCarveSettings(undefined), DEFAULT_CARVE_SETTINGS)
  assert.deepEqual(readCarveSettings({ carve: {
    platforms: ['github', 'unknown'], extensions: ['semantic-span'], inlayHints: false, formatter: 'migration',
    severities: { 'table-width-total': 'error', bogus: 'loud' },
  } }), {
    platforms: ['github'], extensions: ['semantic-span'], inlayHints: false, formatter: 'migration',
    severities: { 'table-width-total': 'error' },
  })
})

test('loads .carverc.json from a workspace root', () => {
  const root = mkdtempSync(path.join(tmpdir(), 'carve-settings-'))
  writeFileSync(path.join(root, '.carverc.json'), JSON.stringify({ carve: { platforms: ['github'] } }))
  assert.deepEqual(readProjectSettings([root])?.platforms, ['github'])
})
