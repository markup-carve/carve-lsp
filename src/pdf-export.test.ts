import assert from 'node:assert/strict'
import test from 'node:test'
import { chmod, mkdtemp, readFile, writeFile, rm } from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { pathToFileURL } from 'node:url'
import { browserCandidates, discoverPdfTool, exportPdf, findExecutable, pdfArguments, readPdfOptions, runPdfTool } from './pdf-export.js'
import { pdfCodeAction } from './export-actions.js'

const emptyEnv = { PATH: '' }

test('PDF source action runs a command without requiring workspace edits', () => {
  assert.equal(pdfCodeAction('untitled:1'), null)
  assert.equal(pdfCodeAction('file:///a.crv', ['quickfix']), null)
  assert.deepEqual(pdfCodeAction('file:///a.crv', ['source'])?.command, {
    title: 'Export as PDF', command: 'carve.exportPdf', arguments: ['file:///a.crv'],
  })
})

test('discovers browser names and default paths on each platform', () => {
  assert.ok(browserCandidates('linux', emptyEnv).includes('chromium'))
  assert.ok(browserCandidates('darwin', emptyEnv).some(name => name.includes('/Applications/Google Chrome.app/Contents/MacOS/Google Chrome')))
  assert.ok(browserCandidates('win32', { PROGRAMFILES: 'C:\\Program Files', PATH: '' }).some(name => name.endsWith('Google\\Chrome\\Application\\chrome.exe')))
})

test('prefers configured crv2pdf and preserves executable paths with spaces', async () => {
  const directory = await mkdtemp(path.join(os.tmpdir(), 'carve pdf test '))
  try {
    const executable = path.join(directory, 'my converter')
    await writeFile(executable, '#!/bin/sh\nexit 0\n')
    await chmod(executable, 0o755)
    assert.equal(await findExecutable(executable), executable)
    assert.deepEqual(await discoverPdfTool({ crv2pdfPath: executable }, emptyEnv), { kind: 'crv2pdf', executable })
    assert.deepEqual(pdfArguments({ kind: 'crv2pdf', executable }, '/a b.crv', '/a b.pdf'), ['/a b.crv', '/a b.pdf'])
    assert.deepEqual(pdfArguments({ kind: 'browser', executable }, '/a b.html', '/a b.pdf', '/tmp/profile'), [
      '--headless', '--disable-gpu', '--no-first-run', '--no-default-browser-check', '--user-data-dir=/tmp/profile', '--print-to-pdf=/a b.pdf', '/a b.html',
    ])
  } finally { await rm(directory, { recursive: true, force: true }) }
})

test('reports a missing converter and parses initialization options', async () => {
  assert.deepEqual(readPdfOptions({ pdf: { crv2pdfPath: '/missing tool', browserPath: '/browser' } }), { crv2pdfPath: '/missing tool', browserPath: '/browser' })
  await assert.rejects(discoverPdfTool({ crv2pdfPath: '/missing tool' }, emptyEnv), /carve\.pdf\.crv2pdfPath/)
  await assert.rejects(discoverPdfTool({ browserPath: '/missing browser' }, emptyEnv), /carve\.pdf\.browserPath/)
  const directory = await mkdtemp(path.join(os.tmpdir(), 'carve-pdf-missing-'))
  try {
    await assert.rejects(exportPdf(pathToFileURL(path.join(directory, 'test.crv')).href, 'hello', () => '<p>hello</p>', {
      crv2pdfPath: '/missing tool',
    }), /carve\.pdf\.crv2pdfPath/)
  } finally { await rm(directory, { recursive: true, force: true }) }
})

test('process failure includes tool stderr', async () => {
  const directory = await mkdtemp(path.join(os.tmpdir(), 'carve-pdf-stderr-'))
  try {
    const executable = path.join(directory, 'bad tool')
    await writeFile(executable, '#!/bin/sh\necho "conversion failed" >&2\nexit 7\n')
    await chmod(executable, 0o755)
    await assert.rejects(runPdfTool({ kind: 'crv2pdf', executable }, []), /code 7: conversion failed/)
  } finally { await rm(directory, { recursive: true, force: true }) }
})

test('prints real HTML with an installed Chromium browser', async (t) => {
  const tool = await discoverPdfTool({}, emptyEnv)
  if (tool?.kind !== 'browser') { t.skip('No Chromium browser is installed on this runner'); return }
  const directory = await mkdtemp(path.join(os.tmpdir(), 'carve pdf browser '))
  try {
    const source = path.join(directory, 'a b.crv')
    await writeFile(source, '# Browser test\n')
    const output = await exportPdf(pathToFileURL(source).href, '# Browser test\n', () => '<!doctype html><title>Test</title><h1>Browser test</h1>', { browserPath: tool.executable })
    assert.equal((await readFile(output)).subarray(0, 5).toString(), '%PDF-')
  } finally { await rm(directory, { recursive: true, force: true }) }
})

test('converter receives the unsaved buffer and sibling output with spaces', async () => {
  const directory = await mkdtemp(path.join(os.tmpdir(), 'carve pdf converter '))
  try {
    const executable = path.join(directory, 'crv2pdf tool')
    await writeFile(executable, '#!/bin/sh\nprintf "%%PDF-" > "$2"\ncat "$1" >> "$2"\n')
    await chmod(executable, 0o755)
    const source = path.join(directory, 'my document.crv')
    await writeFile(source, 'saved old text')
    const output = await exportPdf(pathToFileURL(source).href, 'unsaved new text', () => '<p>unused</p>', { crv2pdfPath: executable })
    assert.equal(output, path.join(directory, 'my document.pdf'))
    assert.equal(await readFile(output, 'utf8'), '%PDF-unsaved new text')
  } finally { await rm(directory, { recursive: true, force: true }) }
})

test('a no-op converter cannot pass using a stale sibling PDF', async () => {
  const directory = await mkdtemp(path.join(os.tmpdir(), 'carve-pdf-stale-'))
  try {
    const executable = path.join(directory, 'noop converter')
    await writeFile(executable, '#!/bin/sh\nexit 0\n')
    await chmod(executable, 0o755)
    const source = path.join(directory, 'note.crv')
    const output = path.join(directory, 'note.pdf')
    await writeFile(source, 'new')
    await writeFile(output, '%PDF-old')
    await assert.rejects(exportPdf(pathToFileURL(source).href, 'new', () => '', { crv2pdfPath: executable }))
    assert.equal(await readFile(output, 'utf8'), '%PDF-old')
  } finally { await rm(directory, { recursive: true, force: true }) }
})
