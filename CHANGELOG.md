# Changelog

All notable changes to carve-lsp are documented in this file.

The format follows [Keep a Changelog](https://keepachangelog.com/en/1.1.0/).

## [Unreleased]

### Fixed

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
