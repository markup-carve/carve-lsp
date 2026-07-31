# Changelog

All notable changes to carve-lsp are documented in this file.

The format follows [Keep a Changelog](https://keepachangelog.com/en/1.1.0/).

## [Unreleased]

### Fixed

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
