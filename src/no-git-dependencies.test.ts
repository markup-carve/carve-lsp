import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test, { after } from 'node:test'
import { fileURLToPath } from 'node:url'

/**
 * The publish-time guard must detect a git dependency by what a spec IS NOT.
 *
 * WHY THIS FILE EXISTS. `ci.yml` already runs `tools/no-git-dependencies.mjs` on
 * every pull request - but only against the manifest committed here, which is
 * clean. So that step passes with the guard's logic in ANY state: delete the
 * whole rule and it still exits zero, because there is nothing in this manifest
 * for it to find. Running the script against a MUTATED manifest is what makes
 * the logic load-bearing rather than the manifest.
 *
 * WHY THE GUARD WAS WIDENED. The rule was already an inversion, but the "not"
 * was still spelled as a list of protocols plus a slash test, and both miss
 * npm's scp-style URL: it carries no protocol, and when the repository sits at
 * the root of its host it carries no slash either. That is the third hole in
 * this guard family in this org - `git+https://` in pandoc-carve, `github:`
 * here, then the bare `owner/repo#ref` shorthand - and each earlier fix added
 * the next spelling to the list, which is why there was a next one (#123).
 * markup-carve/carve-grammars#299 replaced the tail of the list with a catch-all
 * over the characters no registry range can contain; this is that shape.
 *
 * Both directions are asserted. A rejection has to exit non-zero AND name the
 * field, quote the spec and give a reason; an acceptance has to exit zero. So a
 * guard stuck at always-pass and a guard stuck at always-fail each fail here,
 * which is the property the CI step alone does not have.
 *
 * The `npm:` alias row is the near miss that keeps the rule from collapsing into
 * "reject anything with a slash or an at-sign". An alias resolves from the
 * registry, so rejecting it would be an over-broad fix that breaks a manifest
 * that is fine - and an over-rejecting guard gets switched off by whoever hits
 * it, which is worse than the hole.
 */

const root = fileURLToPath(new URL('..', import.meta.url))
const guard = join(root, 'tools', 'no-git-dependencies.mjs')
const manifestPath = join(root, 'package.json')

type Manifest = Record<string, unknown>

const baseline = JSON.parse(readFileSync(manifestPath, 'utf8')) as Manifest & {
  dependencies?: Record<string, string>
  devDependencies?: Record<string, string>
}

const scratch = mkdtempSync(join(tmpdir(), 'carve-lsp-guard-'))
after(() => rmSync(scratch, { recursive: true, force: true }))

/** Run the REAL script against a manifest written to a scratch file. */
const runGuard = (manifest: Manifest): { status: number; out: string } => {
  const path = join(scratch, 'package.json')
  writeFileSync(path, JSON.stringify(manifest, null, 2), 'utf8')
  const run = spawnSync(process.execPath, [guard, path], { encoding: 'utf8' })
  assert.equal(run.error, undefined, `spawning the guard failed: ${run.error}`)
  assert.notEqual(run.status, null, 'the guard was killed by a signal rather than exiting')
  return { status: run.status as number, out: `${run.stdout}${run.stderr}` }
}

const ENGINE = '@markup-carve/carve'
const withDep = (spec: string): Manifest => ({
  ...baseline,
  dependencies: { ...baseline.dependencies, [ENGINE]: spec },
})

/**
 * Each row: what the spec is, the manifest carrying it, and whether a consumer's
 * npm could install it from the registry alone. Cross-checked while writing
 * against `npm-package-arg`, the module npm itself classifies a spec with -
 * every `reject` row is one npa either calls `git` or refuses to classify at
 * all, and every `accept` row is one it calls version, range, tag or alias.
 */
const MATRIX: ReadonlyArray<readonly [string, Manifest, 'accept' | 'reject']> = [
  ['a github: pin', withDep('github:markup-carve/carve-js#61f824d'), 'reject'],
  [
    'a git+https:// pin',
    withDep('git+https://github.com/markup-carve/carve-js.git#61f824d'),
    'reject',
  ],
  [
    'a bare owner/repo#sha shorthand',
    withDep('markup-carve/carve-js#61f824d5d5724bfaa26dd07dc5c159249a66c977'),
    'reject',
  ],
  [
    'a git spec in optionalDependencies',
    { ...baseline, optionalDependencies: { 'some-tool': 'github:markup-carve/some-tool#abc123' } },
    'reject',
  ],
  // The two rows this ticket is about. The first still carries a slash, so the
  // previous version caught it by accident; the second does not, and was
  // accepted.
  ['an scp-style git URL', withDep('git@github.com:markup-carve/carve-js.git'), 'reject'],
  ['an scp-style git URL with no slash', withDep('git@example.com:repo.git'), 'reject'],
  // Caught by the catch-all rather than by a pattern named for them, which is
  // the point of the catch-all: neither was anticipated and both leaked before.
  ['a workspace: protocol spec', withDep('workspace:*'), 'reject'],
  ['a catalog: protocol spec', withDep('catalog:default'), 'reject'],
  ['an exact version', withDep('0.1.4'), 'accept'],
  ['a caret range', withDep('^0.1.4'), 'accept'],
  ['a dist-tag', withDep('latest'), 'accept'],
  ['a compound range', withDep('>=0.1.4 <0.2.0'), 'accept'],
  ['a prerelease version', withDep('0.2.0-beta.1'), 'accept'],
  ['an npm: alias', withDep('npm:@markup-carve/carve@^0.1.4'), 'accept'],
]

for (const [label, manifest, verdict] of MATRIX) {
  test(`${verdict}s ${label}`, () => {
    const { status, out } = runGuard(manifest)
    if (verdict === 'accept') {
      assert.equal(status, 0, `the guard rejected ${label}, which installs fine:\n${out}`)
      return
    }
    assert.notEqual(status, 0, `the guard passed ${label}, which needs git at install time`)
    // A non-zero exit alone would also come from a crash, so the report has to
    // name what it found.
    const optional = (manifest.optionalDependencies ?? {}) as Record<string, string>
    const [field, spec] = Object.keys(optional).length
      ? ['optionalDependencies', Object.values(optional)[0]]
      : ['dependencies', (manifest.dependencies as Record<string, string>)[ENGINE]]
    assert.ok(out.includes(field), `the report does not name the field it found it in:\n${out}`)
    assert.ok(out.includes(spec), `the report does not quote the offending spec:\n${out}`)
    assert.match(out, /registry/i, `the report does not say why:\n${out}`)
  })
}

test("accepts this repo's own manifest", () => {
  // The engine is declared as the exact registry version the v0.1.4 draft is
  // cut from. This row is what keeps that publishable: a widening of the rule
  // that also rejected the committed manifest would block the release.
  const run = spawnSync(process.execPath, [guard, manifestPath], { encoding: 'utf8' })
  assert.equal(
    run.status,
    0,
    `the guard rejects the manifest that is committed here:\n${run.stdout}${run.stderr}`,
  )
})

test('devDependencies are left alone', () => {
  // A contributor's git devDependency costs a consumer nothing, and rejecting it
  // would be the same over-reach the npm: alias row guards against.
  const { status } = runGuard({
    ...baseline,
    devDependencies: { ...baseline.devDependencies, something: 'github:someone/something#abc' },
  })
  assert.equal(status, 0, 'a git devDependency was rejected; only installed fields are in scope')
})

test('both workflows run this script and not their own copy of the rule', () => {
  // The guard is worth nothing if a workflow still carries an inline prefix list
  // beside it, so both halves are pinned for each: the call is there, and no
  // workflow greps the manifest for a spelling of its own.
  for (const workflow of ['ci.yml', 'release.yml']) {
    const text = readFileSync(join(root, '.github', 'workflows', workflow), 'utf8')
    assert.ok(
      text.includes('node tools/no-git-dependencies.mjs'),
      `${workflow} does not call tools/no-git-dependencies.mjs`,
    )
    assert.doesNotMatch(
      text,
      /github:\|git|\^\(github\|git/,
      `${workflow} still carries a prefix-list filter beside the script`,
    )
  }
})
