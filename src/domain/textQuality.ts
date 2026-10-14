// Do not apply blanket NFKC: it rewrites unrelated symbols and language.
const ligatures: Record<string, string> = { 'ﬀ': 'ff', 'ﬁ': 'fi', 'ﬂ': 'fl', 'ﬃ': 'ffi', 'ﬄ': 'ffl', 'ﬅ': 'st', 'ﬆ': 'st' }

/** Conservative token-internal split only: the apostrophe is already attached to
 * an explicit English contraction stem. Spaced quotes (don ' t), possessives,
 * unknown stems and non-English text are left alone. Never fill unknown glyphs. */
const splitContraction = /\b(?:don|doesn|didn|isn|aren|wasn|weren|haven|hasn|hadn|can|couldn|won|wouldn|shouldn|mustn|needn|shan)['’][ \t\n\r]+t\b|\bI['’][ \t\n\r]+m\b|\b(?:I|you|we|they)['’][ \t\n\r]+(?:re|ve|ll)\b/gi

export function normalizeMappedText(value: string) {
  const removed = new Set<number>()
  for (const match of value.matchAll(splitContraction)) {
    for (let i = 0; i < match[0].length; i++) if (/\s/.test(match[0][i])) removed.add(match.index + i)
  }
  let text = '', unmapped = 0
  const source: { start: number; end: number }[] = []
  for (let i = 0; i < value.length; i++) {
    if (removed.has(i)) continue
    let character = value[i]
    if (character === '\u0000' || character === '\ufffd') { character = '\ufffd'; unmapped++ }
    const normalized = ligatures[character] ?? character
    text += normalized
    for (let j = 0; j < normalized.length; j++) source.push({ start: i, end: i + 1 })
  }
  return { text, unmapped, source }
}
export function normalizeExtractedText(value: string): { text: string; unmapped: number } {
  const { text, unmapped } = normalizeMappedText(value)
  return { text, unmapped }
}
