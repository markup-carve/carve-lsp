/**
 * 0.1 helpers that Carve 0.2 has no public call for yet. Only source-level
 * helpers live here, never a tree: include directive sites and expansion
 * warnings, and the Djot migration hints. Each export is a gap tracked on the
 * engine; nothing new may be added.
 */
export {
  applyMigrationFixes,
  djotMigrationWarnings,
  expandIncludes,
  findDirectiveSites,
  selectIncludeRegion,
  parse as parseLegacy,
  resolve as resolveLegacy,
} from '@markup-carve/carve'
export type {
  DirectiveSite,
  Document as LegacyDocument,
  IncludeContext,
  IncludeResolved,
  IncludeUnresolved,
  IncludeWarning,
} from '@markup-carve/carve'
