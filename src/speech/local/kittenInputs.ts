/**
 * The Kitten Micro input pipeline, as audited against the pinned source.
 *
 * Moved out of the private trial worker so the browser path and the tests run
 * the same code. Deliberately faithful to what the trial measured:
 *
 *  - raw browser IPA drops punctuation, so punctuation is re-inserted and
 *    decimal separators between digits are preserved;
 *  - curly quotes and apostrophes map to same-length straight forms before
 *    phonemisation, so source offsets in the caller are never shifted;
 *  - the symbol table is applied in order and the audited last-index-wins
 *    duplicate behaviour is kept, with an unknown symbol raising rather than
 *    being dropped;
 *  - the style row is chosen by the original input's code-point length
 *    (`min(len(text), 399)`), matching the pinned `_prepare_inputs`, not by
 *    phoneme or token count and not by UTF-16 `.length`;
 *  - ids are prefixed with 0 and suffixed with [10, 0].
 */
import table from './kittenSymbols.json'

/** Symbol to id, exactly as shipped: duplicates resolve to the last occurrence. */
export const SYMBOL_TABLE: Record<string, number> = table

/** The style array holds 400 rows (max index 399); the position embedding is [512, 128]. */
export const MAX_STYLE_ROW = 399
/**
 * Conservative ceiling on total input ids. The largest request completed in the
 * recorded trial used 265 ids. 500 is a policy bound chosen below the size of
 * the position embedding, not a measured model maximum: a longer request is
 * split into exact source slices by the caller, never truncated here.
 */
export const MAX_INPUT_IDS = 500

export type Phonemize = (text: string, language: string) => Promise<string[]>

/** Characters that separate phonemisation segments while staying in the input. */
const PUNCTUATION = /[;:!?¡¿—…"«»“”(){}\[\]]|(?<![0-9])[,.]|[,.](?![0-9])/gu

/** `\p{...}` needs a Unicode-aware tokeniser: JavaScript `\w` is not Python's `\w`. */
export function tokenizePhonemes(ipa: string): string {
  return (ipa.match(/[\p{L}\p{N}_]+|[^\p{L}\p{N}_\s]/gu) ?? []).join(' ')
}

const straighten = (text: string) => text.replace(/[“”]/g, '"').replace(/[‘’]/g, "'")

export interface KittenInputs {
  ids: number[]
  styleRow: number
}

/**
 * Phonemise `original` and build the model inputs. Raises `UNKNOWN_PHONEMES`
 * for a symbol the model cannot represent and `TOKEN_LIMIT` when the request
 * exceeds the policy bound, so the caller can split or report instead of
 * speaking a quietly incomplete sentence.
 */
export async function kittenInputs(
  original: string,
  phonemize: Phonemize,
  language = 'en-us',
  symbols: Record<string, number> = SYMBOL_TABLE,
  maxIds = MAX_INPUT_IDS,
): Promise<KittenInputs> {
  const text = straighten(original)
  let ipa = ''
  let at = 0
  for (const match of text.matchAll(PUNCTUATION)) {
    const segment = text.slice(at, match.index)
    if (segment.trim()) ipa += (await phonemize(segment, language)).join(' ')
    ipa += `${match[0]} `
    at = match.index + match[0].length
  }
  const tail = text.slice(at)
  if (tail.trim()) ipa += (await phonemize(tail, language)).join(' ')

  const clean = tokenizePhonemes(ipa)
  if ([...clean].some(symbol => symbols[symbol] === undefined)) throw Error('UNKNOWN_PHONEMES')
  const ids = [0, ...[...clean].map(symbol => symbols[symbol]), 10, 0]
  if (ids.length > maxIds) throw Error('TOKEN_LIMIT')
  return { ids, styleRow: Math.min([...original].length, MAX_STYLE_ROW) }
}
