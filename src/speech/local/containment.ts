/**
 * Smallest-unit repair for a speech part the pronunciation frontend refuses.
 *
 * The accepted frontend rejects a whole part when a single unit cannot be said:
 * a bracket it forwards as a "phone" the model has no symbol for, an ellipsis its
 * NFKC normalisation rewrites into three dots, a standalone quotation mark, a
 * symbol outside its set, or a word whose learned fallback gave up. The worker
 * used to turn that refusal into a terminal error, so one unpronounceable
 * character stopped the whole read.
 *
 * This module bounds the failure to the unit that failed. Everything that can be
 * said is kept, in place: the failing unit is replaced by a documented alternative
 * (a pause mark for an ellipsis, a character's conventional spoken form, or a
 * letter-by-letter spelling) and only a unit with no spoken form at all is
 * dropped. Nothing here edits the source document: the caller still maps the whole
 * part onto its own source span, and every substitution and omission is returned
 * so it can be reported rather than happening silently.
 */

export type OmissionKind = 'pause-mark' | 'silent-punctuation' | 'spoken-form' | 'spelling' | 'dropped'

export interface Omission {
  /** Offsets inside the part the frontend was given. */
  start: number
  end: number
  raw: string
  kind: OmissionKind
  spokenAs?: string
}

export interface RefusalUnit { start: number; end: number; raw: string }

export interface Refusal {
  text: string
  /** Units the frontend could not pronounce at all ("unsupported source character"). */
  unknown: RefusalUnit[]
  /** Characters the frontend forwarded as phones the model has no symbol for, each with the unit that produced it. */
  symbolUnits: RefusalUnit[]
  /** True when the frontend refused the whole text before it could name a unit (its numeric guard). */
  wholeText: boolean
}

export interface Repair { text: string; omissions: Omission[] }

/** An ellipsis is a pause, and the model has a symbol for an em dash. */
export const PAUSE_MARKS: Record<string, string> = { '\u2026': '\u2014', '\u22ef': '\u2014' }

/** Characters that carry no speech: brackets are never voiced. */
export const SILENT_CHARACTERS = new Set([...'()[]{}<>'])

/** Standalone quotation marks carry no speech either. A word-internal apostrophe never reaches here. */
export const QUOTE_CHARACTERS = new Set([...'\u2018\u2019\u201c\u201d\u2032\u2033\'"`'])

/**
 * The conventional spoken form of a character that has no reading as a word.
 * Used only for a unit the frontend refused, never for ordinary punctuation, and
 * every use is reported as a `spoken-form` omission so the substitution is visible
 * in diagnostics instead of passing as the author's own text.
 */
export const SPOKEN_FORMS: Record<string, string> = {
  '&': 'and', '@': 'at', '#': 'number', '©': 'copyright', '®': 'registered', '™': 'trademark',
  '/': 'slash', '\\': 'backslash', '|': 'bar', '%': 'percent', '+': 'plus', '=': 'equals',
  '*': 'star', '^': 'caret', '~': 'tilde', '§': 'section', '°': 'degrees', 'µ': 'micro',
  '±': 'plus or minus', '×': 'times', '÷': 'divided by', '<': 'less than', '>': 'greater than',
  ':': 'colon', '.': 'point', ',': 'comma', '!': 'exclamation mark', '?': 'question mark',
  ';': 'semicolon', '-': 'hyphen', '_': 'underscore', '$': 'dollar', '£': 'pound', '€': 'euro',
  '¡': 'inverted exclamation mark', '¿': 'inverted question mark',
}

const DIGIT_WORDS = ['zero', 'one', 'two', 'three', 'four', 'five', 'six', 'seven', 'eight', 'nine']

/**
 * Spelled readings are for one token at a time. Beyond this many characters the
 * letter names stop being a reading of a word and become noise longer than any
 * spoken word, so the token is reported as dropped instead.
 */
export const SPELL_MAX = 24

/**
 * A letter-by-letter reading of a unit the frontend could not pronounce: digits by
 * name, Latin letters as capitals (the frontend reads a capital letter by name),
 * named symbols by their spoken form. Returns null when any character has no
 * spoken form at all, which is the only case that may be dropped.
 *
 * A lone `A` or `I` resolves through the dictionary's word reading, which is what
 * the accepted frontend does for those two letters; every other letter is by name.
 */
export function spellUnit(raw: string): string | null {
  const characters = [...raw]
  if (!characters.length || characters.length > SPELL_MAX) return null
  const names: string[] = []
  for (const character of characters) {
    if (SILENT_CHARACTERS.has(character) || QUOTE_CHARACTERS.has(character)) continue
    const code = character.codePointAt(0)!
    if (code >= 48 && code <= 57) { names.push(DIGIT_WORDS[code - 48]); continue }
    if (/^[a-z]$/i.test(character)) { names.push(character.toUpperCase()); continue }
    const spoken = SPOKEN_FORMS[character]
    if (spoken) { names.push(spoken); continue }
    return null
  }
  return names.length ? names.join(' ') : null
}

function replaceUnit(raw: string): { text: string; kind: OmissionKind; spokenAs?: string } {
  if (PAUSE_MARKS[raw]) return { text: PAUSE_MARKS[raw], kind: 'pause-mark' }
  const characters = [...raw]
  if (characters.every(character => SILENT_CHARACTERS.has(character) || QUOTE_CHARACTERS.has(character))) {
    return { text: '', kind: 'silent-punctuation' }
  }
  if (characters.every(character => SPOKEN_FORMS[character])) {
    const spoken = characters.map(character => SPOKEN_FORMS[character]).join(' ')
    return { text: spoken, kind: 'spoken-form', spokenAs: spoken }
  }
  const spelled = spellUnit(raw)
  if (spelled) return { text: spelled, kind: 'spelling', spokenAs: spelled }
  return { text: '', kind: 'dropped' }
}

/**
 * The repaired text for one refusal, plus exactly what changed. Overlapping
 * failures are merged first so a character is never replaced twice, and a dropped
 * unit keeps a separating space so two neighbouring words cannot be glued into a
 * different word.
 */
export function planRepair(refusal: Refusal): Repair | null {
  const failing = [...refusal.unknown, ...refusal.symbolUnits]
    .filter(unit => unit.end > unit.start)
    .sort((a, b) => a.start - b.start)
  if (!failing.length) return null
  const spans: RefusalUnit[] = []
  for (const unit of failing) {
    const last = spans.at(-1)
    if (last && unit.start <= last.end) last.end = Math.max(last.end, unit.end)
    else spans.push({ ...unit })
  }
  let text = ''
  let cursor = 0
  const omissions: Omission[] = []
  for (const span of spans) {
    if (span.start < cursor) continue
    text += refusal.text.slice(cursor, span.start)
    const raw = refusal.text.slice(span.start, span.end)
    const replacement = replaceUnit(raw)
    const rest = refusal.text.slice(span.end)
    // Removing punctuation keeps the words on either side apart; a character dropped from
    // inside a word stays inside it, so that word keeps its shape and prosody.
    const separates = replacement.text === '' && replacement.kind === 'silent-punctuation'
      && /\p{L}$/u.test(text) && /^\p{L}/u.test(rest)
    if (replacement.text) text += replacement.text
    else if (separates) text += ' '
    omissions.push({ start: span.start, end: span.end, raw, kind: replacement.kind, spokenAs: replacement.spokenAs })
    cursor = span.end
  }
  text += refusal.text.slice(cursor)
  return { text, omissions }
}

/** Never read aloud: what a part's report counts as dropped. */
export function countDropped(omissions: readonly Omission[]): number {
  return omissions.filter(omission => omission.kind === 'dropped').length
}
