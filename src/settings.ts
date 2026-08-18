import type { LintPlatform } from '@markup-carve/carve'
import { readFileSync } from 'node:fs'
import path from 'node:path'

export interface CarveSettings {
  platforms: LintPlatform[]
  extensions: string[]
  inlayHints: boolean
  formatter: 'conservative' | 'migration'
  severities: Record<string, 'error' | 'warning' | 'information' | 'hint' | 'off'>
}

export const DEFAULT_CARVE_SETTINGS: CarveSettings = {
  platforms: [],
  extensions: [],
  inlayHints: true,
  formatter: 'conservative',
  severities: {},
}

export function readCarveSettings(raw: unknown): CarveSettings {
  const carve = (raw as { carve?: Record<string, unknown> } | undefined)?.carve
  if (!carve) return DEFAULT_CARVE_SETTINGS
  const platforms = Array.isArray(carve['platforms'])
    ? carve['platforms'].filter((value): value is LintPlatform => value === 'github')
    : []
  const extensions = Array.isArray(carve['extensions'])
    ? carve['extensions'].filter((value): value is string => typeof value === 'string')
    : []
  return {
    platforms,
    extensions,
    inlayHints: carve['inlayHints'] !== false,
    formatter: carve['formatter'] === 'migration' ? 'migration' : 'conservative',
    severities: severitySettings(carve['severities']),
  }
}

function severitySettings(value: unknown): CarveSettings['severities'] {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return {}
  const allowed = new Set(['error', 'warning', 'information', 'hint', 'off'])
  return Object.fromEntries(Object.entries(value)
    .filter((entry): entry is [string, CarveSettings['severities'][string]] => allowed.has(String(entry[1]))))
}

export function readProjectSettings(roots: readonly string[]): CarveSettings | null {
  for (const root of roots) {
    try {
      const parsed: unknown = JSON.parse(readFileSync(path.join(root, '.carverc.json'), 'utf8'))
      return readCarveSettings(parsed)
    } catch (error) {
      const code = (error as NodeJS.ErrnoException).code
      if (code === 'ENOENT') continue
      return null
    }
  }
  return null
}
