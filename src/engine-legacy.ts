/**
 * 0.1 helpers that Carve 0.2 has no public call for yet, from the published
 * 0.1 package under the `carve-legacy` alias (the 0.2 package root no longer
 * carries them). Each export names the engine issue that replaces it; nothing
 * new may be added.
 */
// Include expansion with its warnings tied to the including directive: markup-carve/carve-js#5056.
export {
  expandIncludes,
  findDirectiveSites,
  parse as parseLegacy,
} from 'carve-legacy'
// The lines an include region selects: markup-carve/carve-js#5059.
export { selectIncludeRegion } from 'carve-legacy'
// Djot migration hints and their fixes; the 0.1 to 0.2 upgrade as a call: markup-carve/carve-js#5054.
export { applyMigrationFixes, djotMigrationWarnings } from 'carve-legacy'
export type {
  DirectiveSite,
  Document as LegacyDocument,
  IncludeContext,
  IncludeResolved,
  IncludeUnresolved,
  IncludeWarning,
} from 'carve-legacy'
