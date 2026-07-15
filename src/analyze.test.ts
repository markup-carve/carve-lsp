import assert from 'node:assert/strict'
import test from 'node:test'
import { analyzeCarve } from './analyze.js'
import { hoverAt } from './hover.js'
import { migrationCodeActions, migrationFixes } from './migration-actions.js'
import { semanticTokens } from './semantic.js'

test('returns heading document symbols', () => {
  const result = analyzeCarve('# One\n\n## Two\n')
  assert.equal(result.symbols.length, 1)
  assert.equal(result.symbols[0]!.name, 'One')
  assert.equal(result.symbols[0]!.children?.[0]?.name, 'Two')
})

test('reports carve-breakage migration warnings', () => {
  const result = analyzeCarve('**bold**')
  assert.equal(result.diagnostics.length, 1)
  assert.equal(result.diagnostics[0]!.code, 'markdown-strong-double-star')
  assert.deepEqual(result.diagnostics[0]!.range, {
    start: { line: 0, character: 0 },
    end: { line: 0, character: 8 },
  })
})

test('does not diagnose djot-shift constructs (valid Carve)', () => {
  // `_x_` (underline), `~x~` (strikethrough) and `{=x=}` (highlight) are valid
  // Carve; on a hand-written document they are intentional, not mistakes, so
  // they raise no diagnostic. See carve lint's default --from-djot gate.
  for (const src of ['_italic_', 'H~2~O', '{=mark=}']) {
    assert.equal(
      analyzeCarve(src).diagnostics.length,
      0,
      `expected no diagnostic for ${JSON.stringify(src)}`,
    )
  }
})

test('surfaces lintCarve silent-failure warnings as diagnostics', () => {
  const result = analyzeCarve('# Intro\n\nSee </#nope>.')
  const lint = result.diagnostics.find((d) => d.code === 'broken-crossref')
  assert.ok(lint, 'expected a broken-crossref diagnostic')
  assert.equal(lint.source, 'carve')
  assert.equal(lint.range.start.line, 2)
})

test('returns quick fixes for migration warnings', () => {
  const source = '**bold** and ~~strike~~'
  const diagnostics = analyzeCarve(source).diagnostics
  const actions = migrationCodeActions('file:///demo.crv', source, diagnostics)

  // Two per-diagnostic quick fixes, plus the document-wide "fix all" action.
  assert.equal(actions.length, 3)
  assert.equal(actions[0]!.title, 'Convert to Carve syntax: *bold*')
  assert.deepEqual(actions[0]!.edit?.changes?.['file:///demo.crv']?.[0], {
    range: {
      start: { line: 0, character: 0 },
      end: { line: 0, character: 8 },
    },
    newText: '*bold*',
  })

  const fixAll = actions.find((action) => action.title.startsWith('Fix all'))
  assert.ok(fixAll)
  assert.equal(
    fixAll.edit?.changes?.['file:///demo.crv']?.[0]?.newText,
    '*bold* and ~strike~',
  )
})

test('migration quick fixes use canonical single-char Carve delimiters', () => {
  // Guards the delimiter targets the carve-js library hands the LSP through
  // `warning.suggestion`. Carve highlight is a single `=`, and a *doubled*
  // `==x==` is literal text by the same-delimiter-adjacency rule. Subscript
  // and superscript are braced-only: there is no bare `,x,` / `^x^` form (a
  // bare comma or caret is always literal text), so the only spelling is the
  // brace-forced `{,x,}` / `{^x^}`. Suggestions are therefore `{=x=}` and
  // `{,x,}`, never a bare or doubled delimiter form.
  const cases: Array<{ source: string; code: string; newText: string }> = [
    // Djot highlight `{=x=}` is also valid Carve highlight: kept as the
    // identity brace form, NOT reduced to a doubled `==x==` (which is literal).
    { source: '{=mark=}', code: 'djot-highlight-braces', newText: '{=mark=}' },
    // Djot subscript `~x~` would render as Carve strikethrough; the gated
    // `djot-subscript-tilde` rule rewrites it to the brace-forced subscript.
    { source: 'H~2~O', code: 'djot-subscript-tilde', newText: '{,2,}' },
  ]

  // These are djot-shift constructs, so `analyzeCarve` raises no diagnostic for
  // them by default. The suggestion text they carry still has to be canonical,
  // so assert it on `migrationFixes` (the full rule set) directly — that is
  // what feeds the --from-djot quick fixes.
  for (const { source, code, newText } of cases) {
    const fix = migrationFixes(source).find((f) => f.rule === code)
    assert.ok(fix, `expected a ${code} fix for ${JSON.stringify(source)}`)
    assert.equal(fix.suggestion, newText)
    // Never emit the literal doubled delimiter forms.
    assert.doesNotMatch(fix.suggestion, /==|,,/)
  }
})

test('offers a quick fix for + bullets (was missing from the old span map)', () => {
  const source = '+ item'
  const diagnostics = analyzeCarve(source).diagnostics
  assert.equal(diagnostics[0]!.code, 'djot-plus-bullet')
  const actions = migrationCodeActions('file:///demo.crv', source, diagnostics)
  const quickFix = actions.find((a) => a.title === 'Convert to Carve syntax: -')
  assert.ok(quickFix)
  assert.deepEqual(quickFix.edit?.changes?.['file:///demo.crv']?.[0], {
    range: { start: { line: 0, character: 0 }, end: { line: 0, character: 1 } },
    newText: '-',
  })
})

test('returns hover help for inline markup', () => {
  const hover = hoverAt('Use /italic/ text', { line: 0, character: 6 })

  assert.ok(hover)
  assert.equal(typeof hover.contents, 'object')
  assert.ok(!Array.isArray(hover.contents))
  assert.notEqual(typeof hover.contents, 'string')
  const contents = hover.contents as { value?: string }
  assert.match(contents.value ?? '', /Italic/)
})

test('returns semantic tokens for headings and inline markup', () => {
  const result = semanticTokens('# Title\n\nHi *bold* @mark {#id}\n')

  assert.deepEqual(
    result.map((token) => [token.line, token.character, token.length, token.type]),
    [
      [0, 0, 1, 'operator'],
      [0, 2, 5, 'type'],
      [2, 3, 6, 'keyword'],
      [2, 10, 5, 'variable'],
      // carve-js parses the trailing `{#id}` here as a literal `#id` hashtag
      // (tag node) rather than an attribute attachment, so it surfaces as a
      // `variable` token like any other hashtag.
      [2, 17, 3, 'variable'],
    ],
  )
})

test('highlights trailing %% comment from the marker to end of line', () => {
  const result = semanticTokens('Hello %% this is a comment\n')

  assert.deepEqual(
    result.map((token) => [token.line, token.character, token.length, token.type]),
    [[0, 6, 20, 'comment']],
  )
})

test('does not treat %% without preceding space or tab as a comment', () => {
  const noSpace = semanticTokens('50%% off\n')
  assert.deepEqual(noSpace.map((t) => t.type), [])

  const midWord = semanticTokens('a%%b\n')
  assert.deepEqual(midWord.map((t) => t.type), [])
})

test('does not treat escaped %% as a trailing comment', () => {
  // backslash before %% prevents comment
  const result = semanticTokens('literal \x5c%% stuff\n')
  assert.deepEqual(result.filter((t) => t.type === 'comment'), [])
})

test('does not treat %% inside a backtick code span as a trailing comment', () => {
  const result = semanticTokens('\x60code %%\x60 text\n')
  // only the code span token, no comment token
  assert.equal(result.length, 1)
  assert.equal(result[0]!.type, 'string')
})

test('highlights trailing %% preceded by a tab', () => {
  const result = semanticTokens('Hello\t%% comment\n')

  assert.deepEqual(
    result.map((token) => [token.line, token.character, token.length, token.type]),
    [[0, 6, 10, 'comment']],
  )
})

test('returns semantic tokens for fenced blocks', () => {
  const result = semanticTokens('``` js\nconst x = 1\n```\n')

  assert.deepEqual(
    result.map((token) => [token.line, token.character, token.length, token.type]),
    [
      [0, 0, 6, 'string'],
      [1, 0, 11, 'string'],
      [2, 0, 3, 'string'],
    ],
  )
})

test('returns semantic tokens for critic insert markup', () => {
  const result = semanticTokens('{+ inserted text +}')
  assert.deepEqual(
    result.map((token) => [token.line, token.character, token.length, token.type]),
    [[0, 0, 19, 'type']],
  )
})

test('returns semantic tokens for critic delete markup', () => {
  const result = semanticTokens('{- removed text -}')
  assert.deepEqual(
    result.map((token) => [token.line, token.character, token.length, token.type]),
    [[0, 0, 18, 'comment']],
  )
})

test('returns semantic tokens for critic substitute markup', () => {
  const result = semanticTokens('{~ old ~>new ~}')
  assert.deepEqual(
    result.map((token) => [token.line, token.character, token.length, token.type]),
    [[0, 0, 15, 'keyword']],
  )
})

test('returns semantic tokens for critic annotation markup', () => {
  const result = semanticTokens('{= highlight =}')
  assert.deepEqual(
    result.map((token) => [token.line, token.character, token.length, token.type]),
    [[0, 0, 15, 'keyword']],
  )
})

test('returns semantic tokens for critic comment markup', () => {
  const result = semanticTokens('{# a note #}')
  assert.deepEqual(
    result.map((token) => [token.line, token.character, token.length, token.type]),
    [[0, 0, 12, 'comment']],
  )
})

test('returns semantic tokens for display math', () => {
  const result = semanticTokens('$$E=mc2$$')
  assert.deepEqual(
    result.map((token) => [token.line, token.character, token.length, token.type]),
    [[0, 0, 9, 'string']],
  )
})

test('returns semantic tokens for inline math', () => {
  const result = semanticTokens('$x=1$')
  assert.deepEqual(
    result.map((token) => [token.line, token.character, token.length, token.type]),
    [[0, 0, 5, 'string']],
  )
})

test('returns semantic tokens for reference definition', () => {
  const result = semanticTokens('[carve]: https://example.com')
  assert.deepEqual(
    result.map((token) => [token.line, token.character, token.length, token.type]),
    [
      [0, 0, 1, 'operator'],
      [0, 1, 5, 'type'],
      [0, 6, 3, 'operator'],
      [0, 9, 19, 'string'],
    ],
  )
})

test('returns semantic tokens for footnote definition', () => {
  const result = semanticTokens('[^fn]: footnote text')
  assert.deepEqual(
    result.map((token) => [token.line, token.character, token.length, token.type]),
    [
      [0, 0, 2, 'operator'],
      [0, 2, 2, 'type'],
      [0, 4, 3, 'operator'],
    ],
  )
})

test('returns semantic tokens for abbreviation definition', () => {
  const result = semanticTokens('*[HTML]: HyperText Markup Language')
  assert.deepEqual(
    result.map((token) => [token.line, token.character, token.length, token.type]),
    [[0, 0, 34, 'property']],
  )
})

test('returns semantic tokens for YAML frontmatter', () => {
  const result = semanticTokens('---\ntitle: Test\n---\n')
  assert.deepEqual(
    result.map((token) => [token.line, token.character, token.length, token.type]),
    [
      [0, 0, 3, 'string'],
      [1, 0, 11, 'string'],
      [2, 0, 3, 'string'],
    ],
  )
})
