import { analyzeCarve, type Analysis, type AnalyzeOptions } from './analyze.js'
import { IncludeParseCache, IncludeSourceCache } from './include-cache.js'
import { includeOptionsFor, previewIncludeOptionsFor, type IncludeSettings } from './include-settings.js'
import type { IncludeOptions } from './includes.js'

/**
 * Everything one analysis needs, as plain data: it crosses into the analysis
 * worker by structured clone, so it carries the include gate's inputs rather
 * than a resolver function.
 */
export interface AnalysisJob {
  uri: string
  source: string
  lint: AnalyzeOptions['lint']
  includeGate: IncludeGate
}

export interface IncludeGate {
  settings: IncludeSettings
  workspaceTrusted: boolean
  workspaceRoots: string[]
  /** Open buffers by canonical path; an include of one reads the buffer, not the disk. */
  openDocuments: OpenDocument[]
}

export interface OpenDocument {
  path: string
  source: string
  version: number
}

export interface AnalysisCaches {
  sources: IncludeSourceCache
  parses: IncludeParseCache
}

export function newAnalysisCaches(): AnalysisCaches {
  return { sources: new IncludeSourceCache(), parses: new IncludeParseCache() }
}

/** Could `gate` hand out an include capability at all? Cheap, so open buffers are collected only when it can. */
export function includesPossible(settings: IncludeSettings, workspaceTrusted: boolean): boolean {
  return settings.enabled === 'on' || (settings.enabled === 'auto' && workspaceTrusted)
}

export function runAnalysisJob(job: AnalysisJob, caches: AnalysisCaches): Analysis {
  const includes = jobIncludeOptions(job.uri, job.includeGate, caches, false)
  return analyzeCarve(job.source, {
    uri: job.uri,
    lint: job.lint,
    ...(includes ? { includes } : {}),
    includedParseCache: caches.parses,
  })
}

export function jobIncludeOptions(uri: string, gate: IncludeGate, caches: AnalysisCaches, preview: boolean): IncludeOptions | undefined {
  const input = {
    uri,
    settings: gate.settings,
    workspaceTrusted: gate.workspaceTrusted,
    workspaceRoots: gate.workspaceRoots,
    cache: caches.sources,
  }
  const options = preview ? previewIncludeOptionsFor(input) : includeOptionsFor(input)
  return options && withOpenDocuments(options, gate.openDocuments)
}

function withOpenDocuments(options: IncludeOptions, openDocuments: readonly OpenDocument[]): IncludeOptions {
  const diskResolver = options.resolver
  if (!diskResolver || openDocuments.length === 0) return options
  const openByPath = new Map(openDocuments.map((open) => [open.path, open]))
  options.resolver = (includePath, context) => {
    const result = diskResolver(includePath, context)
    if (!result.ok) return result
    const open = openByPath.get(result.id)
    if (!open) return result
    return { ...result, source: open.source, bytes: Buffer.byteLength(open.source), version: `open:${open.version}` }
  }
  return options
}
