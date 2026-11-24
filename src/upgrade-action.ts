/**
 * The Carve 0.1 to 0.2 upgrade (`upgrade` from `@markup-carve/carve/upgrade`) as
 * a source action and the `carve.upgrade` command. The upgrade entry carries the
 * 0.1 reader, so it is loaded on first use, never at server start.
 */
import {
  CodeActionKind,
  DiagnosticSeverity,
  Range,
  TextEdit,
  type CodeAction,
  type Diagnostic,
  type Position,
} from 'vscode-languageserver-types'
import { astOffsetToIndex } from './position.js'

export const UPGRADE_KIND = `${CodeActionKind.Source}.upgrade`
export const UPGRADE_COMMAND = 'carve.upgrade'

type UpgradeModule = typeof import('@markup-carve/carve/upgrade')
let engine: Promise<UpgradeModule> | undefined

export interface UpgradeRecord {
  entry: string
  class: string
  line: number
  message: string
  range?: { startOffset: number, endOffset: number }
}

export interface UpgradePlan {
  /** The edits from the 0.1 source to the 0.2 source; empty when nothing changes. */
  edits: TextEdit[]
  /** False when the engine's self-check found a rendering difference (`check: mismatch`): nothing may be applied. */
  writable: boolean
  check: string
  records: UpgradeRecord[]
  /** The records a person has to look at, as diagnostics on the 0.1 source. */
  review: Diagnostic[]
}

// Engine offsets count the line-ending-normalized source; its line and
// character positions match the live document.
function normalize(source: string): string {
  return source.replace(/\r\n?/g, '\n')
}

function positionAt(source: string, index: number): Position {
  const before = source.slice(0, index)
  const lastNewline = before.lastIndexOf('\n')
  return { line: before.split('\n').length - 1, character: index - lastNewline - 1 }
}

function needsReview(record: UpgradeRecord): boolean {
  return record.class === 'report' || record.class === 'mismatch' || record.class === 'unverified explanation'
}

function reviewDiagnostic(source: string, record: UpgradeRecord): Diagnostic {
  const line = Math.max(0, record.line - 1)
  const range = record.range
    ? Range.create(positionAt(source, record.range.startOffset), positionAt(source, record.range.endOffset))
    : Range.create(line, 0, line, (source.split('\n')[line] ?? '').length)
  return {
    range,
    severity: record.class === 'mismatch' ? DiagnosticSeverity.Warning : DiagnosticSeverity.Information,
    code: record.entry,
    source: 'carve upgrade',
    message: record.message,
  }
}

/** What the upgrade would do to `source`. */
export async function planUpgrade(source: string): Promise<UpgradePlan> {
  const { upgrade } = await (engine ??= import('@markup-carve/carve/upgrade'))
  const norm = normalize(source)
  const result = upgrade(norm, { edits: true })
  const records = result.records as UpgradeRecord[]
  const writable = result.check === 'pass' || result.check === 'explained'
  const at = (byte: number) => positionAt(norm, astOffsetToIndex(norm, byte))
  const edits = !result.changed
    ? []
    : result.edits
      ? result.edits.map((edit) => TextEdit.replace(Range.create(at(edit.range.startOffset), at(edit.range.endOffset)), edit.text))
      : [TextEdit.replace(Range.create(positionAt(norm, 0), positionAt(norm, norm.length)), result.output)]
  return {
    edits,
    writable,
    check: result.check,
    records,
    review: records.filter(needsReview).map((record) => reviewDiagnostic(norm, record)),
  }
}

/** One line per record that needs a person, for a message. */
export function reviewSummary(plan: UpgradePlan): string {
  return plan.review.map((item) => `line ${item.range.start.line + 1}: ${item.code} ${item.message}`).join('\n')
}

/**
 * *Upgrade to Carve 0.2*, offered when the upgrade changes the document. A
 * document whose rendering the upgrade would change gets the action disabled
 * with the reason, where the client can show that, and no action otherwise.
 */
export function upgradeCodeAction(
  uri: string,
  plan: UpgradePlan,
  disabledSupport: boolean,
): CodeAction | null {
  if (plan.edits.length === 0) return null
  const title = 'Upgrade to Carve 0.2'
  if (!plan.writable) {
    if (!disabledSupport) return null
    const first = plan.review.find((item) => item.severity === DiagnosticSeverity.Warning) ?? plan.review[0]
    return {
      title,
      kind: UPGRADE_KIND,
      disabled: { reason: `The upgrade would change how this document renders${first ? ` (line ${first.range.start.line + 1}: ${first.message})` : ''}; rewrite it by hand.` },
    }
  }
  const action: CodeAction = { title, kind: UPGRADE_KIND, edit: { changes: { [uri]: plan.edits } } }
  if (plan.review.length) {
    // The client runs the command after the edit, so what the upgrade left to a person is shown, not dropped.
    action.title = `${title} (${plan.review.length} to review)`
    action.command = { title: 'Show what the upgrade left for review', command: UPGRADE_COMMAND, arguments: [uri, { review: reviewSummary(plan) }] }
  }
  return action
}

/**
 * Whether a code action request asks for source actions. A request without
 * `only` (a cursor move) does not run the upgrade, which renders the document
 * with both engines.
 */
export function wantsUpgrade(only: string[] | undefined): boolean {
  return only !== undefined && only.some((kind) => UPGRADE_KIND === kind || UPGRADE_KIND.startsWith(`${kind}.`))
}
