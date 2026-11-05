import { spawn } from 'node:child_process'
import { constants } from 'node:fs'
import { access, mkdtemp, rename, stat, unlink, writeFile, rm } from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { randomUUID } from 'node:crypto'
import { fileURLToPath } from 'node:url'

export interface PdfOptions { crv2pdfPath?: string; browserPath?: string }
export type PdfTool = { kind: 'crv2pdf' | 'browser'; executable: string }

const BROWSERS: Record<string, string[]> = {
  linux: ['google-chrome', 'google-chrome-stable', 'chromium', 'chromium-browser', 'microsoft-edge', '/usr/bin/google-chrome', '/usr/bin/chromium', '/usr/bin/microsoft-edge'],
  darwin: ['Google Chrome.app/Contents/MacOS/Google Chrome', 'Chromium.app/Contents/MacOS/Chromium', 'Microsoft Edge.app/Contents/MacOS/Microsoft Edge'],
  win32: ['Google/Chrome/Application/chrome.exe', 'Chromium/Application/chrome.exe', 'Microsoft/Edge/Application/msedge.exe'],
}

export function browserCandidates(platform: string, env: NodeJS.ProcessEnv): string[] {
  const names = BROWSERS[platform] ?? BROWSERS.linux!
  if (platform === 'darwin') return [...names.map(name => path.posix.join('/Applications', name)), ...names.map(name => path.posix.join(os.homedir(), 'Applications', name))]
  if (platform === 'win32') return [...names.flatMap(name => [env.PROGRAMFILES, env['PROGRAMFILES(X86)'], env.LOCALAPPDATA].filter((base): base is string => !!base).map(base => path.win32.join(base, name))), 'chrome.exe', 'msedge.exe', 'chromium.exe']
  return names
}

export async function findExecutable(candidate: string, env: NodeJS.ProcessEnv = process.env, platform = process.platform): Promise<string | null> {
  const suffixes = platform === 'win32' && !path.win32.extname(candidate) ? ['.exe', ''] : ['']
  const directories = path.isAbsolute(candidate) || candidate.includes('/') || candidate.includes('\\') ? [''] : (env.PATH ?? '').split(path.delimiter)
  for (const directory of directories) for (const suffix of suffixes) {
    const file = directory ? path.join(directory, candidate + suffix) : candidate + suffix
    try { await access(file, platform === 'win32' ? constants.F_OK : constants.X_OK); return file } catch { /* try next candidate */ }
  }
  return null
}

export async function discoverPdfTool(options: PdfOptions = {}, env = process.env, platform = process.platform): Promise<PdfTool | null> {
  if (options.crv2pdfPath) {
    const executable = await findExecutable(options.crv2pdfPath, env, platform)
    if (!executable) throw new Error(`Configured carve.pdf.crv2pdfPath was not found: ${options.crv2pdfPath}`)
    return { kind: 'crv2pdf', executable }
  }
  const converter = await findExecutable('crv2pdf', env, platform)
  if (converter) return { kind: 'crv2pdf', executable: converter }
  if (options.browserPath) {
    const executable = await findExecutable(options.browserPath, env, platform)
    if (!executable) throw new Error(`Configured carve.pdf.browserPath was not found: ${options.browserPath}`)
    return { kind: 'browser', executable }
  }
  for (const candidate of browserCandidates(platform, env)) {
    const executable = await findExecutable(candidate, env, platform)
    if (executable) return { kind: 'browser', executable }
  }
  return null
}

export function pdfArguments(tool: PdfTool, input: string, output: string, profile?: string): string[] {
  if (tool.kind === 'crv2pdf') return [input, output]
  return ['--headless', '--disable-gpu', '--no-first-run', '--no-default-browser-check', ...(profile ? [`--user-data-dir=${profile}`] : []), `--print-to-pdf=${output}`, input]
}

export function runPdfTool(tool: PdfTool, args: string[], timeoutMs = 60_000): Promise<void> {
  return new Promise((resolve, reject) => {
    const child = spawn(tool.executable, args, { shell: false, stdio: ['ignore', 'ignore', 'pipe'] })
    let stderr = ''
    const timer = setTimeout(() => child.kill('SIGKILL'), timeoutMs)
    child.stderr.setEncoding('utf8')
    child.stderr.on('data', (chunk: string) => { stderr = (stderr + chunk).slice(-8192) })
    child.on('error', error => { clearTimeout(timer); reject(new Error(`${tool.kind} could not start: ${error.message}`)) })
    child.on('close', code => {
      clearTimeout(timer)
      if (code === 0) resolve()
      else reject(new Error(`${tool.kind} ${code === null ? 'timed out or was terminated' : `exited with code ${code}`}${stderr.trim() ? `: ${stderr.trim()}` : ''}`))
    })
  })
}

export async function exportPdf(uri: string, source: string, html: () => string, options: PdfOptions = {}): Promise<string> {
  const original = fileURLToPath(uri)
  const output = /\.crv$/i.test(original) ? original.replace(/\.crv$/i, '.pdf') : `${original}.pdf`
  const tool = await discoverPdfTool(options)
  if (!tool) throw new Error('PDF export needs crv2pdf (install markup-carve/carve-pdf or set carve.pdf.crv2pdfPath) or a Chromium browser (install Chrome, Chromium, or Edge, or set carve.pdf.browserPath).')
  const temp = path.join(path.dirname(original), `.carve-export-${randomUUID()}.${tool.kind === 'browser' ? 'html' : 'crv'}`)
  const freshOutput = path.join(path.dirname(original), `.carve-export-${randomUUID()}.pdf`)
  let profile: string | undefined
  try {
    if (tool.kind === 'browser') {
      await writeFile(temp, html(), { flag: 'wx' })
      profile = await mkdtemp(path.join(os.tmpdir(), 'carve-pdf-profile-'))
    } else {
      // Use the current buffer, including unsaved edits, beside the document so relative assets resolve.
      await writeFile(temp, source, { flag: 'wx' })
    }
    await runPdfTool(tool, pdfArguments(tool, temp, freshOutput, profile))
    const result = await stat(freshOutput)
    if (result.size === 0) throw new Error(`${tool.kind} produced an empty PDF`)
    await rename(freshOutput, output)
    return output
  } finally {
    await unlink(temp).catch(() => {})
    await unlink(freshOutput).catch(() => {})
    if (profile) await rm(profile, { recursive: true, force: true })
  }
}

export function readPdfOptions(raw: unknown): PdfOptions {
  const pdf = (raw as { pdf?: unknown } | undefined)?.pdf
  if (!pdf || typeof pdf !== 'object') return {}
  const values = pdf as Record<string, unknown>
  return {
    crv2pdfPath: typeof values.crv2pdfPath === 'string' ? values.crv2pdfPath : undefined,
    browserPath: typeof values.browserPath === 'string' ? values.browserPath : undefined,
  }
}
