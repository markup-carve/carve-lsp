import assert from 'node:assert/strict'
import test from 'node:test'
import { mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { analyzeCarve } from './analyze.js'
import { fileSystemResolver, type IncludeDenial } from './include-path.js'
import { resolveIncludes } from './includes.js'

// A containment refusal and a missing file are different failures, and PART 9
// §19 keeps one rule id for both (the include-conformance goldens `i10-fs-*`
// pin `include-unresolved` on every denial, and the engine's resolver contract
// returns a bare `null`). The DIAGNOSTIC is not that contract, so the code and
// the wording separate them. One assertion per test: a suite stops at the first
// failure, so rows behind it would never run.

function diagnose(source: string, denial: IncludeDenial) {
  const result = analyzeCarve(source, {
    includes: {
      resolver: (includePath) => ({ ok: false, id: includePath, denial }),
      sourcePath: '/ws/doc.crv',
      includeRoot: '/ws',
    },
  })
  const [diagnostic] = result.diagnostics.filter((item) => item.source === 'carve')
  assert.ok(diagnostic, `expected a diagnostic for ${denial}`)
  return diagnostic
}

test('a containment refusal publishes include-denied, not include-unresolved', () => {
  assert.equal(diagnose('{{ ../outside.crv }}\n', 'outside-root').code, 'include-denied')
})

test('a containment refusal says the target is outside the include root', () => {
  assert.match(diagnose('{{ ../outside.crv }}\n', 'outside-root').message, /outside the include root/)
})

test('a containment refusal no longer claims the target could not be resolved', () => {
  assert.doesNotMatch(
    diagnose('{{ ../outside.crv }}\n', 'outside-root').message,
    /could not be resolved/,
  )
})

// The control. A file that really is missing must keep reporting as missing, or
// the new code means nothing.
test('a genuinely missing target still publishes include-unresolved', () => {
  assert.equal(diagnose('{{ chapters/missing.crv }}\n', 'not-found').code, 'include-unresolved')
})

test('a genuinely missing target keeps its unresolved wording', () => {
  assert.match(diagnose('{{ chapters/missing.crv }}\n', 'not-found').message, /could not be resolved/)
})

test('an absolute path refusal publishes include-denied', () => {
  assert.equal(diagnose('{{ /etc/passwd }}\n', 'absolute-denied').code, 'include-denied')
})

test('an absolute path refusal says absolute paths are not allowed', () => {
  assert.match(diagnose('{{ /etc/passwd }}\n', 'absolute-denied').message, /absolute include paths/)
})

test('a remote refusal publishes include-denied', () => {
  assert.equal(diagnose('{{ https://host/x.crv }}\n', 'remote-not-allowed').code, 'include-denied')
})

test('a remote refusal says remote includes are never fetched', () => {
  assert.match(diagnose('{{ https://host/x.crv }}\n', 'remote-not-allowed').message, /never fetched/)
})

// §19 lists non-text content as its own degradation and `include-non-text` is
// the canonical rule id for it; #191 already uses it for a NUL-bearing target.
// A FIFO, a device or a directory was still reported as a missing file.
test('a target that is not a regular file publishes include-non-text', () => {
  assert.equal(diagnose('{{ chapters }}\n', 'not-a-file').code, 'include-non-text')
})

test('a resolver that throws keeps include-unresolved, since no class is known', () => {
  const result = analyzeCarve('{{ a.crv }}\n', {
    includes: {
      resolver: () => {
        throw new Error('ENOENT: open /home/someone/secret/a.crv')
      },
      sourcePath: '/ws/doc.crv',
    },
  })
  assert.equal(result.diagnostics.find((item) => item.source === 'carve')?.code, 'include-unresolved')
})

// §19 I7. The internal token stays internal; the message names the class in the
// processor's own prose.
test('the internal denial token never reaches the published message', () => {
  assert.doesNotMatch(diagnose('{{ ../outside.crv }}\n', 'outside-root').message, /outside-root/)
})

// The cross-engine contract. Changing this would diverge from four
// include-conformance goldens and could not survive #187, where the engine owns
// the warning and can only spell `include-unresolved`.
test('the cross-engine rule id on the warning is still include-unresolved', () => {
  const result = resolveIncludes('{{ ../outside.crv }}\n', {
    resolver: (includePath) => ({ ok: false, id: includePath, denial: 'outside-root' }),
  })
  assert.equal(result.warnings[0]?.rule, 'include-unresolved')
})

test('the warning carries the refusal class for the diagnostic layer to map', () => {
  const result = resolveIncludes('{{ ../outside.crv }}\n', {
    resolver: (includePath) => ({ ok: false, id: includePath, denial: 'outside-root' }),
  })
  assert.equal(result.warnings[0]?.denial, 'outside-root')
})

/**
 * The reason distinguishing a refusal from a miss is not a host-layout probe:
 * the answer does not depend on whether the refused target exists. Driven
 * through the real filesystem resolver on a real tree, not a stub.
 */
function outsideDiagnostics(): { present: string; absent: string } {
  const base = realpathSync(mkdtempSync(path.join(tmpdir(), 'carve-lsp-denial-')))
  test.after(() => rmSync(base, { recursive: true, force: true }))
  mkdirSync(path.join(base, 'root'))
  writeFileSync(path.join(base, 'root', 'doc.crv'), '')
  writeFileSync(path.join(base, 'present.crv'), 'TOP SECRET\n')
  const root = path.join(base, 'root')
  const analyze = (spec: string): string => {
    const result = analyzeCarve(`{{ ${spec} }}\n`, {
      includes: {
        resolver: fileSystemResolver(root),
        sourcePath: path.join(root, 'doc.crv'),
        includeRoot: root,
      },
    })
    const diagnostic = result.diagnostics.find((item) => item.source === 'carve')
    assert.ok(diagnostic, `expected a diagnostic for ${spec}`)
    return `${String(diagnostic.code)} ${diagnostic.message}`
  }
  return { present: analyze('../present.crv'), absent: analyze('../absent.crv') }
}

test('an outside target that exists is refused as include-denied', () => {
  assert.match(outsideDiagnostics().present, /^include-denied /)
})

test('an outside target that exists and one that does not are indistinguishable', () => {
  const { present, absent } = outsideDiagnostics()
  assert.equal(present.replace('present', 'X'), absent.replace('absent', 'X'))
})
