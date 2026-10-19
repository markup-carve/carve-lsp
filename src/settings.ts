import type { LintPlatform } from '@markup-carve/carve'
import { readFileSync } from 'node:fs'
import path from 'node:path'

export interface CarveSettings {
  platforms: LintPlatform[]
  extensions: string[]
  inlayHints: boolean
  /** `inlayHints.bareListMarkers`: ghost text after a bare marker on the line being edited. */
  bareListMarkerHints: boolean
  exportActions: boolean
  formatter: 'conservative' | 'migration'
  formatAlignTables: boolean
  severities: Record<string, 'error' | 'warning' | 'information' | 'hint' | 'off'>
}

export const DEFAULT_CARVE_SETTINGS: CarveSettings = {
  platforms: [],
  extensions: [],
  inlayHints: true,
  bareListMarkerHints: true,
  exportActions: true,
  formatter: 'conservative',
  formatAlignTables: false,
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
    bareListMarkerHints: carve['inlayHints'] !== false && subSetting(carve['inlayHints'], 'bareListMarkers'),
    exportActions: carve['exportActions'] !== false,
    formatter: carve['formatter'] === 'migration' ? 'migration' : 'conservative',
    formatAlignTables: formatAlignTables(carve),
    severities: severitySettings(carve['severities']),
  }
}

function formatAlignTables(carve: Record<string, unknown>): boolean {
  const format = carve['format']
  return (format !== null && typeof format === 'object' && !Array.isArray(format)
    && (format as Record<string, unknown>)['alignTables'] === true)
    || carve['format.alignTables'] === true
}

// `inlayHints` is a boolean, or an object of per-hint switches that default to on.
function subSetting(value: unknown, key: string): boolean {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return true
  return (value as Record<string, unknown>)[key] !== false
}

function severitySettings(value: unknown): CarveSettings['severities'] {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return {}
  const allowed = new Set(['error', 'warning', 'information', 'hint', 'off'])
  return Object.fromEntries(Object.entries(value)
    .filter((entry): entry is [string, CarveSettings['severities'][string]] => allowed.has(String(entry[1]))))
}

type CarveSection = Record<string, unknown>

export function carveSection(raw: unknown): CarveSection | undefined {
  const carve = (raw as { carve?: unknown } | null | undefined)?.carve
  return carve !== null && typeof carve === 'object' && !Array.isArray(carve) ? carve as CarveSection : undefined
}

// Folds the dotted `format.alignTables` spelling into `format`, so a client
// `false` can override a project `true` key by key.
function normalizeSection(carve: CarveSection): CarveSection {
  const { 'format.alignTables': dotted, ...rest } = carve
  if (dotted === undefined) return rest
  const format = rest['format'] !== null && typeof rest['format'] === 'object' && !Array.isArray(rest['format'])
    ? rest['format'] as CarveSection
    : {}
  return { ...rest, format: { ...format, alignTables: dotted } }
}

/**
 * Client keys win, keys the client did not send come from `.carverc.json`,
 * the rest are defaults.
 */
export function mergeCarveSettings(client: CarveSection | undefined, project: CarveSection | undefined): CarveSettings {
  if (!client && !project) return DEFAULT_CARVE_SETTINGS
  const fromProject = project ? normalizeSection(project) : {}
  const fromClient = client ? normalizeSection(client) : {}
  const merged: CarveSection = { ...fromProject }
  for (const [key, value] of Object.entries(fromClient)) {
    const base = merged[key]
    // Object settings (`format`, `severities`, `inlayHints`) merge one level deep.
    merged[key] = isPlainObject(base) && isPlainObject(value) ? { ...base, ...value } : value
  }
  return readCarveSettings({ carve: merged })
}

function isPlainObject(value: unknown): value is CarveSection {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
}

/** The `carve` section of the first `.carverc.json`; `null` when that file is unreadable or invalid. */
export function readProjectSection(roots: readonly string[]): CarveSection | undefined | null {
  for (const root of roots) {
    try {
      const parsed: unknown = JSON.parse(readFileSync(path.join(root, '.carverc.json'), 'utf8'))
      return carveSection(parsed)
    } catch (error) {
      const code = (error as NodeJS.ErrnoException).code
      if (code === 'ENOENT') continue
      return null
    }
  }
  return undefined
}

export function readProjectSettings(roots: readonly string[]): CarveSettings | null {
  const section = readProjectSection(roots)
  if (section === null) return null
  return section ? readCarveSettings({ carve: section }) : null
}
