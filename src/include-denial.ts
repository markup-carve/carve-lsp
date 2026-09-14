/**
 * Diagnostic classification for a resolver refusal (PART 9 §19).
 *
 * The cross-engine RULE id stays `include-unresolved` for every refusal. Four
 * include-conformance goldens pin it on exactly these shapes
 * (`i10-fs-dotdot-escape-denied`, `i10-fs-symlink-dir-escape-denied`,
 * `i10-fs-symlink-file-and-dotdot-denied`, `i10-fs-absolute-path-denied`), and
 * the engine could not spell anything else if it wanted to: its resolver
 * contract is `IncludeResolved | null`, so missing and refused arrive
 * indistinguishable.
 *
 * A DIAGNOSTIC code is not that contract, and this server's resolver already
 * computes the class - `outside-root` is not `not-found`. The diagnostic used
 * to discard it, telling an author whose include was REFUSED that the file
 * could not be found.
 *
 * Publishing the class discloses nothing: a target outside the root is refused
 * whether or not it exists (the containment test runs on a canonical candidate
 * built for a missing path too), and the absolute and remote refusals are
 * decided from the spelling alone. §19 I7 is satisfied as before - the message
 * is processor-generated, names the class in prose, and never carries a
 * resolver error or a path the author did not write.
 *
 * The seam survives #187: once the engine's `expandIncludes` owns the walk, the
 * adapter narrowing this resolver to `IncludeResolved | null` records the
 * denial per directive path and hands `null` on, and the engine's
 * `include-unresolved` warning is joined back to the class here.
 */
import type { IncludeDenial } from './include-path.js'

interface DenialDiagnostic {
  /** Published diagnostic code. NOT the cross-engine rule id. */
  code: string
  /** Prose reason, spliced into the message. Names no path and no errno. */
  reason: string
}

/**
 * `not-found` is deliberately absent: a target that is merely missing IS
 * unresolved, and keeping `include-unresolved` on it is what makes the new
 * codes mean something.
 */
const DENIALS: Partial<Record<IncludeDenial, DenialDiagnostic>> = {
  'outside-root': {
    code: 'include-denied',
    reason: 'it resolves outside the include root',
  },
  'absolute-denied': {
    code: 'include-denied',
    reason: 'absolute include paths are not allowed',
  },
  'remote-not-allowed': {
    code: 'include-denied',
    reason: 'remote includes are never fetched',
  },
  'not-a-file': {
    // §19 lists non-text content as its own degradation, and `include-non-text`
    // is the canonical rule id for it. A FIFO, a device or a directory is no
    // more a document than a binary file is.
    code: 'include-non-text',
    reason: 'the target is not a regular file',
  },
}

/** Diagnostic code for a refusal, or undefined to keep `include-unresolved`. */
export function includeDenialCode(denial: IncludeDenial): string | undefined {
  return DENIALS[denial]?.code
}

/** Message for a refusal, or undefined to keep the unresolved wording. */
export function includeDenialMessage(
  denial: IncludeDenial,
  includePath: string,
): string | undefined {
  const entry = DENIALS[denial]
  return entry && `Include "${includePath}" was refused: ${entry.reason}.`
}
