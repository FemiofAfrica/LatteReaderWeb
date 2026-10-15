/**
 * Turns a pronunciation refusal into the smallest honest repair, one unit at a time.
 *
 * `containment.ts` decides what a single refused unit should become; this module
 * runs that decision against the real frontend, re-checks the repaired text, and
 * reports exactly what was substituted or dropped. It is deliberately free of
 * worker APIs so the same code the reader runs can be unit tested.
 *
 * Rules it keeps:
 *  - a part is never refused because of one unit: the rest of the part is read;
 *  - the accepted style rule is kept: the style row follows the ORIGINAL text's
 *    code-point length, so a repair cannot change the voice's character;
 *  - a token-budget refusal is not a pronunciation failure and stays TOKEN_LIMIT,
 *    which the engine answers by splitting at a real word boundary;
 *  - a part that cannot be repaired at all is reported as refused, so the engine
 *    can skip that part and keep reading from the same position.
 */
import { planRepair, countDropped, type Omission, type RefusalUnit, type Refusal } from './containment'

export interface PreparedUnit { raw: string; start: number; end: number; kind?: string; phones?: string[] }

export interface PreparedText {
  ok: boolean
  tokenLimitExceeded: boolean
  ids: number[]
  styleRow: number
  units: PreparedUnit[]
  unknown: RefusalUnit[]
  unsupported: string[]
  sourceUnits: number
  coveredUnits: number
}

export type Preparer = (text: string) => PreparedText

export interface ContainedPrepared extends PreparedText {
  contained: boolean
  omissions: Omission[]
  /** Units whose sound was dropped entirely: the only thing a reader is told about. */
  dropped: number
  /** Units that were read, but by a documented alternative to their written form. */
  readByOtherMeans: number
}

/** Bounded so one pathological part cannot spend the whole run re-checking itself. */
export const MAX_REPAIR_ATTEMPTS = 3

/** The units that produced a phone the model has no symbol for. */
function symbolUnits(prepared: PreparedText): RefusalUnit[] {
  if (!prepared.unsupported.length || !prepared.units) return []
  const unsupported = new Set(prepared.unsupported)
  return prepared.units
    .filter(unit => unit.phones?.some(phones => [...phones].some(symbol => unsupported.has(symbol))))
    .map(unit => ({ start: unit.start, end: unit.end, raw: unit.raw }))
}

/**
 * The frontend refuses the whole text before it names a unit when its numeric guard
 * rejects ambiguous notation. Every guard alternative contains a digit, so the
 * offender is found by asking the same frontend about the digit-bearing tokens.
 */
function wholeTextRefusals(text: string, prep: Preparer): RefusalUnit[] {
  const spans: RefusalUnit[] = []
  for (const match of text.matchAll(/\S*\d\S*/g)) {
    try { prep(match[0]) }
    catch { spans.push({ start: match.index!, end: match.index! + match[0].length, raw: match[0] }) }
  }
  return spans
}

function refused(text: string, styleRow: number, omissions: Omission[]): ContainedPrepared {
  return {
    ok: false, tokenLimitExceeded: false, ids: [], styleRow, units: [], unknown: [], unsupported: [],
    sourceUnits: 0, coveredUnits: 0, contained: omissions.length > 0, omissions, dropped: countDropped(omissions),
    readByOtherMeans: omissions.length - countDropped(omissions),
  }
}

function repaired(prepared: PreparedText, styleRow: number, omissions: Omission[]): ContainedPrepared {
  return {
    ...prepared, styleRow, contained: omissions.length > 0, omissions,
    dropped: countDropped(omissions), readByOtherMeans: omissions.length - countDropped(omissions),
  }
}

export function containedPrepare(text: string, prep: Preparer): ContainedPrepared {
  const styleRow = Math.min([...text].length, 399)
  const omissions: Omission[] = []
  let candidate = text
  for (let attempt = 0; attempt <= MAX_REPAIR_ATTEMPTS; attempt += 1) {
    let refusal: Refusal | null = null
    try {
      const prepared = prep(candidate)
      if (prepared.ok || prepared.tokenLimitExceeded) return repaired(prepared, styleRow, omissions)
      refusal = { text: candidate, unknown: prepared.unknown ?? [], symbolUnits: symbolUnits(prepared), wholeText: false }
    } catch {
      refusal = { text: candidate, unknown: [], symbolUnits: wholeTextRefusals(candidate, prep), wholeText: true }
    }
    const repair = planRepair(refusal)
    if (!repair) break
    omissions.push(...repair.omissions)
    // An empty repair still counts: every unit was dropped and the engine must skip
    // this part rather than inventing silence that claims the text was read.
    if (!repair.text.trim() || repair.text === candidate) break
    candidate = repair.text
  }
  return refused(candidate, styleRow, omissions)
}
