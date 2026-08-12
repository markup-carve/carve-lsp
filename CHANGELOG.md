# Changelog

All notable changes to carve-lsp are documented in this file.

The format follows [Keep a Changelog](https://keepachangelog.com/en/1.1.0/).

## [Unreleased]

### Changed

- Diagnostics are coalesced per document instead of running on every keystroke
  (markup-carve/carve-lsp#68). Analysis is whole-document - a full parse and
  resolve plus the migration and lint passes - so one run per edit multiplies
  that cost by the typing rate on large files. Edits now settle for a short
  window (120 ms by default) and produce one run, and a queued run is REPLACED
  rather than queued behind, so diagnostics computed for a superseded version
  are never published. Opening a document still analyzes immediately, and
  closing one cancels any queued run.

### Added

- Track resolved and missing local include dependencies with dynamic file
  watchers. A child change invalidates bounded source and parsed-tree caches
  and revalidates every open including document.
- Go to definition on an include directive opens the contained child through
  the same guarded resolver used for diagnostics.
- Include headings in document-symbol results with locations attributed to
  their child files.

## [0.1.2] - 2026-08-10

### Added
- **File inclusion (`{{ path }}`) is resolved, and its failures are
  diagnostics.** Off by default: the server enables it only when the client
  asks, and under `"auto"` only for a workspace the client reports as trusted.
  Targets must canonicalize inside the containment root (the workspace root
  unless overridden), so a symlink or `..` path leaving the root, and an
  absolute path outside it, are refused. Remote URLs are never fetched.
  Recursion depth and total expanded bytes are both bounded. Settings live
  under `carve.includes`; see the README.

### Fixed
- **The engine is pinned exactly rather than by range.** `@markup-carve/carve`
  was depended on as `^0.1.2`, which is `>=0.1.2 <0.2.0` - precisely the range
  `docs/versioning.md` says may carry behavior changes before 1.0. Every
  sibling repo in the org pins an exact version or commit. A new test asserts
  the unit the pinned engine's AST columns count in, so a release that changes
  it fails here rather than shipping positions that are right on ASCII and
  wrong on any astral character.

- Both footnote forms keep their `variable` semantic token across the carve-js
  AST split. carve-js split `footnote` into `footnote_ref` and
  `inline_footnote` (markup-carve/carve#405); this package pins a published
  `^0.1.2` that still emits the old name, so all three are accepted and the two
  can be released in either order. Without it the split node falls through to
  the default and loses its token - a footnote marker silently stops being
  highlighted.

### Fixed

- Critic comments keep their `comment` semantic token across the carve-js AST
  rename. carve-js renamed the node type `critic-comment` to `critic_comment`
  (markup-carve/carve-js#454); this package pins a published `^0.1.2` that still
  emits the old spelling, so both are accepted and the two can be released in
  either order. Without this the node would have fallen through to the generic
  brace handling and highlighted as a `keyword` - a mis-colored comment rather
  than a visible failure.

- The plain-text walks behind outline symbols, cross-reference matching and
  go-to-definition no longer drop `smart_punctuation` nodes. Carve represents a
  typographic substitution as its own inline node rather than writing the glyph
  into the text buffer, and the if/else-if chains had no final branch, so every
  quote, apostrophe, dash and ellipsis silently vanished from the extracted
  text: `# Don't repeat yourself` became `Dont repeat yourself`. The shared
  fallback resolves the node's glyph, or its source run when the glyph is not
  set, and stays silent for anything else.

## [0.1.1] - 2026-07-27

### Changed

- Track carve-js `0.1.2`: follow the spec node-type vocabulary (the snake_case
  AST discriminant rename) and depend on the published `@markup-carve/carve`
  `^0.1.2` instead of a git-sha pin, so the package installs self-contained.

### Added

- Handle the inline literal `` !`…` `` construct.

## [0.1.0] - 2026-07-15

### Added

- Initial Carve language server: diagnostics, hover, and the `carve lint`
  integration.
