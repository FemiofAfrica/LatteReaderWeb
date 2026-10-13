// Do not apply blanket NFKC: it rewrites unrelated symbols and language.
const ligatures: Record<string, string> = { 'ﬀ': 'ff', 'ﬁ': 'fi', 'ﬂ': 'fl', 'ﬃ': 'ffi', 'ﬄ': 'ffl', 'ﬅ': 'st', 'ﬆ': 'st' }
export function normalizeExtractedText(value: string): { text: string; unmapped: number } {
  let unmapped = 0
  const text = value.replace(/[\u0000\ufffd]/g, () => { unmapped += 1; return '\ufffd' })
    .replace(/[ﬀﬁﬂﬃﬄﬅﬆ]/g, c => ligatures[c])
  return { text, unmapped }
}
