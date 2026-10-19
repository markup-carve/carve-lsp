import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import type { CompletionItem, TextEdit } from 'vscode-languageserver/node.js'
import { includeCompletions } from './include-completion.js'
import { findDirectives } from './include-directive.js'

/*
 * Completion inside an include directive.
 *
 * The load-bearing property is that every suggestion inserts text the SCANNER
 * accepts. The section half used to fire only on `path#fragment`, which is not
 * the directive grammar - `findDirectives` returns nothing for it - so taking
 * the suggestion silently turned the directive into prose.
 */

function workspace(): { root: string; sourcePath: string } {
  const root = mkdtempSync(path.join(tmpdir(), 'carve-include-complete-'))
  writeFileSync(path.join(root, 'chapter.crv'), '# First section\n\nBody.\n\n## Deeper bit\n')
  mkdirSync(path.join(root, 'parts'))
  writeFileSync(path.join(root, 'parts', 'appendix.crv'), '# Appendix\n')
  writeFileSync(path.join(root, 'with space.crv'), '# Spaced\n')
  return { root, sourcePath: path.join(root, 'main.crv') }
}

const at = (line: string) => ({ line: 0, character: line.length })
const labels = (items: { label: string }[]) => items.map((item) => item.label)

function editOf(item: CompletionItem | undefined): TextEdit {
  const edit = item?.textEdit
  assert.ok(edit && 'range' in edit, 'completion must carry a plain TextEdit')
  return edit
}

/** The line as it reads once the completion has been applied. */
function applied(text: string, item: CompletionItem | undefined): string {
  const edit = editOf(item)
  return text.slice(0, edit.range.start.character) + edit.newText + text.slice(edit.range.end.character)
}

// --- path -----------------------------------------------------------------

test('completes contained files from a partial name', () => {
  const { root, sourcePath } = workspace()
  const text = '{{ cha'
  const items = includeCompletions(text, at(text), { sourcePath, includeRoot: root })
  assert.deepEqual(labels(items), ['chapter.crv'])
})

test('a trailing separator lists that directory, not its parent', () => {
  const { root, sourcePath } = workspace()
  const text = '{{ parts/'
  const items = includeCompletions(text, at(text), { sourcePath, includeRoot: root })
  assert.deepEqual(labels(items), ['appendix.crv'])
})

test('a trailing separator replaces nothing already typed', () => {
  const { root, sourcePath } = workspace()
  const text = '{{ parts/'
  const [item] = includeCompletions(text, at(text), { sourcePath, includeRoot: root })
  assert.equal(editOf(item).range.start.character, text.length)
})

// --- section --------------------------------------------------------------

test('completes sections on the grammatical spelling, space and all', () => {
  const { root, sourcePath } = workspace()
  const text = '{{ chapter.crv #'
  const items = includeCompletions(text, at(text), { sourcePath, includeRoot: root })
  assert.deepEqual(labels(items), ['#First-section', '#Deeper-bit'])
})

test('completes sections from a partial fragment', () => {
  const { root, sourcePath } = workspace()
  const text = '{{ chapter.crv #Deep'
  const items = includeCompletions(text, at(text), { sourcePath, includeRoot: root })
  assert.deepEqual(labels(items), ['#First-section', '#Deeper-bit'])
})

test('the fragment spelled without its space still completes', () => {
  const { root, sourcePath } = workspace()
  const text = '{{ chapter.crv#Deep'
  const items = includeCompletions(text, at(text), { sourcePath, includeRoot: root })
  assert.ok(labels(items).includes('#Deeper-bit'))
})

test('the fragment spelled without its space is REPAIRED to carry one', () => {
  const { root, sourcePath } = workspace()
  const text = '{{ chapter.crv#Deep'
  const item = includeCompletions(text, at(text), { sourcePath, includeRoot: root }).find(
    (candidate) => candidate.label === '#Deeper-bit',
  )
  assert.equal(editOf(item).newText, ' #Deeper-bit')
})

test('applying a section completion yields text the scanner accepts', () => {
  const { root, sourcePath } = workspace()
  const text = '{{ chapter.crv#Deep'
  const item = includeCompletions(text, at(text), { sourcePath, includeRoot: root }).find(
    (candidate) => candidate.label === '#Deeper-bit',
  )
  const line = applied(text, item)
  assert.equal(findDirectives(`${line} }}`).length, 1, `"${line} }}" must scan as one directive`)
})

test('applying a section completion selects the section it named', () => {
  const { root, sourcePath } = workspace()
  const text = '{{ chapter.crv#Deep'
  const item = includeCompletions(text, at(text), { sourcePath, includeRoot: root }).find(
    (candidate) => candidate.label === '#Deeper-bit',
  )
  assert.equal(findDirectives(`${applied(text, item)} }}`)[0]?.section, 'Deeper-bit')
})

// --- option names ---------------------------------------------------------

test('completes the option names after the sigil', () => {
  const { root, sourcePath } = workspace()
  const text = '{{ chapter.crv @'
  const items = includeCompletions(text, at(text), { sourcePath, includeRoot: root })
  assert.deepEqual(labels(items).sort(), ['@code', '@code:', '@lines:', '@region:', '@shift:'])
})

test('an option already spelled is not offered a second time', () => {
  const { root, sourcePath } = workspace()
  const text = '{{ chapter.crv @shift:2 @'
  const items = includeCompletions(text, at(text), { sourcePath, includeRoot: root })
  assert.deepEqual(labels(items), ['@lines:', '@region:', '@code', '@code:'])
})

test('an option completion replaces the sigil and its separator', () => {
  const { root, sourcePath } = workspace()
  const text = '{{ chapter.crv @li'
  const [item] = includeCompletions(text, at(text), { sourcePath, includeRoot: root })
  assert.equal(editOf(item).range.start.character, text.length - 4)
})

test('an option completion leaves the separator it replaced intact', () => {
  const { root, sourcePath } = workspace()
  const text = '{{ chapter.crv @li'
  const [item] = includeCompletions(text, at(text), { sourcePath, includeRoot: root })
  assert.equal(applied(text, item), '{{ chapter.crv @lines:')
})

test('applying an option completion yields text the scanner accepts', () => {
  const { root, sourcePath } = workspace()
  const text = '{{ chapter.crv @sh'
  const item = includeCompletions(text, at(text), { sourcePath, includeRoot: root }).find(
    (candidate) => candidate.label === '@shift:',
  )
  assert.equal(findDirectives(`${applied(text, item)}auto }}`).length, 1)
})

// --- option values --------------------------------------------------------

test('offers the shift value shapes, auto included', () => {
  const { root, sourcePath } = workspace()
  const text = '{{ chapter.crv @shift:'
  const items = includeCompletions(text, at(text), { sourcePath, includeRoot: root })
  assert.deepEqual(labels(items), ['auto', '+1', '-1'])
})

test('offers the whole-file line range, counted from the child', () => {
  const { root, sourcePath } = workspace()
  const text = '{{ chapter.crv @lines:'
  const items = includeCompletions(text, at(text), { sourcePath, includeRoot: root })
  assert.deepEqual(labels(items), ['1-5'])
})

test('applying a line-range completion yields text the scanner accepts', () => {
  const { root, sourcePath } = workspace()
  const text = '{{ chapter.crv @lines:'
  const [item] = includeCompletions(text, at(text), { sourcePath, includeRoot: root })
  assert.deepEqual(findDirectives(`${applied(text, item)} }}`)[0]?.lines, { start: 1, end: 5 })
})

// --- containment and quiet cases -----------------------------------------

test('offers nothing outside a directive', () => {
  const { root, sourcePath } = workspace()
  const text = 'A tag #hea and a mention @nam'
  assert.deepEqual(includeCompletions(text, at(text), { sourcePath, includeRoot: root }), [])
})

test('offers nothing once the directive is closed', () => {
  const { root, sourcePath } = workspace()
  const text = '{{ chapter.crv }} and then @'
  assert.deepEqual(includeCompletions(text, at(text), { sourcePath, includeRoot: root }), [])
})

test('offers no sections for a target outside the containment root', () => {
  const { root, sourcePath } = workspace()
  const text = '{{ ../escape.crv #'
  assert.deepEqual(includeCompletions(text, at(text), { sourcePath, includeRoot: root }), [])
})

// --- separators and quoted paths -----------------------------------------
// Regressions found by review: both branches below produced suggestions that
// the scanner rejects, or refused to fire on a directive that is perfectly
// legal.

test('an option typed against a previous value carries its separator', () => {
  const { root, sourcePath } = workspace()
  const text = '{{ chapter.crv @shift:1@'
  const item = includeCompletions(text, at(text), { sourcePath, includeRoot: root }).find(
    (candidate) => candidate.label === '@lines:',
  )
  assert.equal(editOf(item).newText, ' @lines:')
})

test('an option typed against a previous value still yields a parsable directive', () => {
  const { root, sourcePath } = workspace()
  const text = '{{ chapter.crv @shift:1@'
  const item = includeCompletions(text, at(text), { sourcePath, includeRoot: root }).find(
    (candidate) => candidate.label === '@lines:',
  )
  assert.equal(findDirectives(`${applied(text, item)}1-2 }}`).length, 1)
})

test('a quoted path completes its sections', () => {
  const { root, sourcePath } = workspace()
  const text = '{{ "with space.crv" #'
  const items = includeCompletions(text, at(text), { sourcePath, includeRoot: root })
  assert.deepEqual(labels(items), ['#Spaced'])
})

test('a quoted path completes its line range', () => {
  const { root, sourcePath } = workspace()
  const text = '{{ "with space.crv" @lines:'
  const items = includeCompletions(text, at(text), { sourcePath, includeRoot: root })
  assert.deepEqual(labels(items), ['1-1'])
})

test('a quoted path completes its option names', () => {
  const { root, sourcePath } = workspace()
  const text = '{{ "with space.crv" @'
  const items = includeCompletions(text, at(text), { sourcePath, includeRoot: root })
  assert.deepEqual(labels(items).sort(), ['@code', '@code:', '@lines:', '@region:', '@shift:'])
})

test('a half-typed quoted path completes the file name', () => {
  const { root, sourcePath } = workspace()
  const text = '{{ "with sp'
  const items = includeCompletions(text, at(text), { sourcePath, includeRoot: root })
  assert.deepEqual(labels(items), ['with space.crv'])
})

test('a quoted path is not offered a second set of quotes', () => {
  const { root, sourcePath } = workspace()
  const text = '{{ "with sp'
  const [item] = includeCompletions(text, at(text), { sourcePath, includeRoot: root })
  assert.equal(editOf(item).newText, 'with space.crv"')
})

// --- quoting, and what may precede an option -----------------------------
// Second review round: both branches below advertised a path or an option
// whose inserted form the scanner rejects.

test('a name that cannot be spelled bare is offered under its plain label', () => {
  const { root, sourcePath } = workspace()
  const text = '{{ with'
  const items = includeCompletions(text, at(text), { sourcePath, includeRoot: root })
  assert.deepEqual(labels(items), ['with space.crv'])
})

test('a name that cannot be spelled bare is INSERTED quoted', () => {
  const { root, sourcePath } = workspace()
  const text = '{{ with'
  const [item] = includeCompletions(text, at(text), { sourcePath, includeRoot: root })
  assert.equal(editOf(item).newText, '"with space.crv"')
})

test('a quoted path completion yields text the scanner accepts', () => {
  const { root, sourcePath } = workspace()
  const text = '{{ with'
  const [item] = includeCompletions(text, at(text), { sourcePath, includeRoot: root })
  assert.equal(findDirectives(`${applied(text, item)} }}`).length, 1)
})

test('a half-typed quoted path is closed by the completion', () => {
  const { root, sourcePath } = workspace()
  const text = '{{ "with sp'
  const [item] = includeCompletions(text, at(text), { sourcePath, includeRoot: root })
  assert.equal(applied(text, item), '{{ "with space.crv"')
})

test('a half-typed quoted path completion yields text the scanner accepts', () => {
  const { root, sourcePath } = workspace()
  const text = '{{ "with sp'
  const [item] = includeCompletions(text, at(text), { sourcePath, includeRoot: root })
  assert.equal(findDirectives(`${applied(text, item)} }}`)[0]?.path, 'with space.crv')
})

test('no option is offered after text that is not a directive prefix', () => {
  const { root, sourcePath } = workspace()
  const text = '{{ chapter.crv nonsense @'
  assert.deepEqual(includeCompletions(text, at(text), { sourcePath, includeRoot: root }), [])
})

test('no option value is offered after text that is not a directive prefix', () => {
  const { root, sourcePath } = workspace()
  const text = '{{ chapter.crv nonsense @shift:'
  assert.deepEqual(includeCompletions(text, at(text), { sourcePath, includeRoot: root }), [])
})

test('an option is still offered after a section, which IS a legal prefix', () => {
  const { root, sourcePath } = workspace()
  const text = '{{ chapter.crv #Deeper-bit @'
  const items = includeCompletions(text, at(text), { sourcePath, includeRoot: root })
  // Only the transform: @lines, @region and @code each conflict with a section.
  assert.deepEqual(labels(items), ['@shift:'])
})

// --- curly quotes and an empty target ------------------------------------
// Third review round.

test('a curly-opened path is closed with the curly delimiter', () => {
  const { root, sourcePath } = workspace()
  const text = '{{ “with sp'
  const [item] = includeCompletions(text, at(text), { sourcePath, includeRoot: root })
  assert.equal(applied(text, item), '{{ “with space.crv”')
})

test('a curly-quoted completion yields text the scanner accepts', () => {
  const { root, sourcePath } = workspace()
  const text = '{{ “with sp'
  const [item] = includeCompletions(text, at(text), { sourcePath, includeRoot: root })
  assert.equal(findDirectives(`${applied(text, item)} }}`)[0]?.path, 'with space.crv')
})

test('an empty target is offered no line range', () => {
  const { root, sourcePath } = workspace()
  writeFileSync(path.join(root, 'empty.crv'), '')
  const text = '{{ empty.crv @lines:'
  assert.deepEqual(includeCompletions(text, at(text), { sourcePath, includeRoot: root }), [])
})

// --- @region and @code (carve-lsp#589) -----------------------------------

function regionWorkspace(): { root: string; sourcePath: string } {
  const { root, sourcePath } = workspace()
  writeFileSync(
    path.join(root, 'readme.crv'),
    ['%% #region requirements', '- PHP 8.3', '%% #endregion requirements', '#region bare', 'Text.', '#endregion', ''].join('\n'),
  )
  writeFileSync(
    path.join(root, 'server.js'),
    [
      '// #region start',
      'listen()',
      '// #endregion start',
      '/* #region css */',
      '/* #endregion */',
      '<!-- #region html -->',
      '<!-- #endregion -->',
      '-- #region sql',
      '-- #endregion',
      '#region py',
      '#endregion',
      '%% #region carve',
      '%% #endregion',
      '',
    ].join('\n'),
  )
  return { root, sourcePath }
}

test('a Carve include offers only the regions behind a %% marker', () => {
  const { root, sourcePath } = regionWorkspace()
  const text = '{{ readme.crv @region:'
  const items = includeCompletions(text, at(text), { sourcePath, includeRoot: root })
  // The bare `#region bare` pair is ordinary text in a Carve include.
  assert.deepEqual(labels(items), ['requirements'])
  const carveOnly = '{{ server.js @region:'
  assert.deepEqual(labels(includeCompletions(carveOnly, at(carveOnly), { sourcePath, includeRoot: root })), ['carve'])
})

test('a malformed %% marker leaves no region to offer', () => {
  const { root, sourcePath } = regionWorkspace()
  writeFileSync(path.join(root, 'broken.crv'), '%% #region ok\n- PHP\n%% #endregion\n%% #region-x\n')
  const text = '{{ broken.crv @region:'
  assert.deepEqual(includeCompletions(text, at(text), { sourcePath, includeRoot: root }), [])
})

test('a code include offers the regions of every source-comment form', () => {
  const { root, sourcePath } = regionWorkspace()
  const text = '{{ server.js @code:js @region:'
  const items = includeCompletions(text, at(text), { sourcePath, includeRoot: root })
  assert.deepEqual(labels(items), ['start', 'css', 'html', 'sql', 'py', 'carve'])
})

test('a @code later in the directive still selects the code marker set', () => {
  const { root, sourcePath } = regionWorkspace()
  const line = '{{ server.js@region: @code:js }}'
  const cursor = { line: 0, character: '{{ server.js@region:'.length }
  const items = includeCompletions(line, cursor, { sourcePath, includeRoot: root })
  assert.deepEqual(labels(items), ['start', 'css', 'html', 'sql', 'py', 'carve'])
})

test('an unpaired or duplicated marker leaves no region to offer', () => {
  const { root, sourcePath } = regionWorkspace()
  writeFileSync(path.join(root, 'broken.js'), '// #region a\n// #region a\n// #endregion\n// #endregion\n')
  const text = '{{ broken.js @code @region:'
  assert.deepEqual(includeCompletions(text, at(text), { sourcePath, includeRoot: root }), [])
})

test('applying a region completion yields a directive the scanner accepts', () => {
  const { root, sourcePath } = regionWorkspace()
  const text = '{{ server.js @code:js @region:'
  const item = includeCompletions(text, at(text), { sourcePath, includeRoot: root }).find((c) => c.label === 'start')
  const [directive] = findDirectives(`${applied(text, item)} }}`)
  assert.equal(directive?.region, 'start')
  assert.deepEqual(directive?.code, { lang: 'js' })
})

test('@code offers the fence languages', () => {
  const { root, sourcePath } = workspace()
  const text = '{{ chapter.crv @code:'
  const items = labels(includeCompletions(text, at(text), { sourcePath, includeRoot: root }))
  for (const language of ['javascript', 'python', 'text', 'mermaid']) assert.ok(items.includes(language), language)
})

test('a bare @code completes and the next option is still offered after it', () => {
  const { root, sourcePath } = workspace()
  const text = '{{ chapter.crv @co'
  const item = includeCompletions(text, at(text), { sourcePath, includeRoot: root }).find((c) => c.label === '@code')
  const after = `${applied(text, item)} @`
  assert.deepEqual(findDirectives(`${applied(text, item)} }}`)[0]?.code, {})
  const next = labels(includeCompletions(after, at(after), { sourcePath, includeRoot: root }))
  assert.deepEqual(next, ['@lines:', '@region:', '@shift:'])
})

test('a selection is not offered a second selection', () => {
  const { root, sourcePath } = workspace()
  const text = '{{ chapter.crv @lines:1-2 @'
  assert.deepEqual(labels(includeCompletions(text, at(text), { sourcePath, includeRoot: root })), [
    '@shift:',
    '@code',
    '@code:',
  ])
})
