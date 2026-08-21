# Changelog

All notable changes to carve-lsp are documented in this file.

The format follows [Keep a Changelog](https://keepachangelog.com/en/1.1.0/).

## [Unreleased]

### Added

- Workspace intelligence: a versioned index of headings, captions, footnotes,
  citations and link-reference definitions across `.crv` files, behind workspace
  symbols and cross-file definition, references, completion and rename.
  Renaming a generated heading ID inserts an explicit `{#new-id}` declaration
  before rewriting its references. The initial census is bounded to 10,000 files
  and 64 MiB and skips `.git` and `node_modules` (#103).
- Document links, document highlights, selection ranges, generated-heading-ID
  inlay hints, contained include-path and included-section completion, and the
  `carve.previewHtml` and `carve.showAst` commands (#103).
- LSP 3.17 pull diagnostics alongside the existing push path, plus semantic-token
  full, delta and range support with table-specific tokens (#103).
- Safe fixes for malformed raw blocks, blockquote spacing, table alignment
  padding and missing footnote or link definitions, and table diagnostics for
  alignment-run padding, column metadata arity, marker/attribute overlap and
  width totals (#103, markup-carve/carve#1344).
- `.carverc.json` and client configuration for lint platforms, extensions, inlay
  hints, formatter mode and per-rule severity overrides (#103).
- Conservative range formatting and on-type continuation for quotes, tables and
  definitions; canonical migration formatting stays explicit opt-in (#103).

### Fixed

- The formatter preserves blank-line runs, trailing blank lines and trailing
  whitespace, each of which can be structural Carve source. Adding a missing
  final line ending is the one normalization it keeps, and the formatter is now
  gated on rendered-HTML equivalence across every corpus document (#108, #105).
- **`package.json` is importable, so the installed version can be read back**
  (#118, #117). The subpath was not in `exports`, so reading it threw
  `ERR_PACKAGE_PATH_NOT_EXPORTED` - which reads as the package being absent
  rather than the subpath being closed. Only that one file is opened; every
  other path stays refused.

## [0.1.3] - 2026-08-18

### Added

- Advertise full-document semantic tokens and answer
  `textDocument/semanticTokens/full` requests. Unlike a line-local TextMate
  grammar, the parsed token stream can distinguish an unclosed top-level `%%%`
  comment fence (which degrades to a one-line comment) from a closed comment
  fence, so one stray opener no longer has to scope the rest of the document as
  a comment (markup-carve/carve-lsp#101).

- **Composite figures are a container the server knows** (spec PART 9 §4c,
  markup-carve/carve#1215). A bare `::: figure` fence parses to a `figure_group`
  node, which the server had no case for, so the container silently stopped
  folding, hovering and producing semantic tokens. It now folds like any other
  fenced container, hovers with its own description, and its opener carries the
  reserved kind word as a `type` token - including the `^ ` caption below the
  CLOSING fence, which belongs to the group rather than to anything inside it.
  `::: ` completion offers `figure` alongside the eight admonition kinds, listed
  separately because it is not a ninth one. An opener carrying a title or a
  `[label]` is unchanged and still an admonition.

- **A cross-reference reaches a captioned host, not only a heading** (spec PART
  9R R4, markup-carve/carve-lsp#79). `</#id>` naming a figure, a table, a
  composite figure or one of its panels now completes, jumps to its host, finds
  its usages, and hovers with the text it resolves to - "Figure 2" for a group,
  "Figure 2a" for its first panel. Every crossref feature walked headings only
  before this, so a reference to a plain captioned figure - a construct that
  predates composite figures entirely - offered no completion and jumped
  nowhere. Hovering one reported it as a heading, because no case existed for
  the reference and the lexical fallback matched the `#` inside it.

  The number is the engine's own resolved `caption_number`; only the panel
  letter (a..z, then aa) is derived here, and the tests pin it against the
  anchor text the engine renders for the same id. An unnumbered group's panels
  stay anchors without crossref text, which is what PART 9 §4c says they are,
  and completion leaves such an id out rather than offering a reference that
  renders as literal text. Find-references answers from the declaration too -
  the block-attribute line above a captioned host, which is where its id is
  actually written - and not only from a usage.

- **The outline carries a composite figure and nests its panels.** The group is
  named by its caption, says how many panels it holds, and hangs under the
  section it appears in - a group takes no heading level, so it never closes
  one. A panel is named by its own caption, falling back to the letter a
  crossref would use for it.

### Changed

- The `@markup-carve/carve` dependency moves from its development commit pin to
  the published `0.1.4` release. Besides the composite-figure support this
  server needs, 0.1.4 fixes URL sanitization for every candidate in list-valued
  attributes such as `srcset`; consumers no longer need Git to install the LSP.

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
