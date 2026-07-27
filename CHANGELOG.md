# Changelog

All notable changes to carve-lsp are documented in this file.

The format follows [Keep a Changelog](https://keepachangelog.com/en/1.1.0/).

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
