import { normalizeMappedText } from './textQuality'
import type { SpeechChunk } from './speechPlan'

export interface SourceCharacter { pageNumber: number; start: number; end: number }
export interface ReadingPosition {
  offset: number
  evidence: 'boundary' | 'utterance'
  ranges: SourceCharacter[]
}

/** UTF-16 source mapping, including expanded ligatures and collapsed whitespace.
 * Never search for a word at callback time: repeated text retains its own provenance. */
export function mappedSpeech(text: string, pageNumber: number, base = 0) {
  const repaired = normalizeMappedText(text)
  let value = ''
  const source: SourceCharacter[] = []
  for (let i = 0; i < repaired.text.length;) {
    const start = i
    if (repaired.text[i] === '\u00ad') { i++; while (i < repaired.text.length && /\s/.test(repaired.text[i])) i++; continue }
    let normalized: string
    if (/\s/.test(repaired.text[i])) {
      while (i < repaired.text.length && /\s/.test(repaired.text[i])) i++
      normalized = ' '
    } else { normalized = repaired.text[i++] }
    value += normalized
    for (let j = 0; j < normalized.length; j++) source.push({ pageNumber, start: base + repaired.source[start].start, end: base + repaired.source[i - 1].end })
  }
  const left = value.length - value.trimStart().length
  const right = value.trimEnd().length
  return { text: value.slice(left, right), source: source.slice(left, right) }
}

export function readingTimeline(chunks: readonly SpeechChunk[]) {
  let text = ''
  const source: (SourceCharacter | null)[] = []
  const starts: number[] = []
  for (const chunk of chunks) {
    if (text) { text += ' '; source.push(null) }
    starts.push(text.length)
    text += chunk.text
    for (const item of chunk.source ?? Array(chunk.text.length).fill(null)) source.push(item)
  }
  const sentences: { start: number; end: number }[] = []
  // Consume every character, including decimal points and abbreviations that are not
  // followed by whitespace. A sentence recognizer must never drop source prefixes.
  const pattern = /[\s\S]+?(?:[.!?]+[”’"']*(?=\s|$)|$)/g
  for (const match of text.matchAll(pattern)) {
    const leading = match[0].length - match[0].trimStart().length
    const start = match.index + leading
    const end = match.index + match[0].trimEnd().length
    if (end > start) sentences.push({ start, end })
  }
  if (!sentences.length && text) sentences.push({ start: 0, end: text.length })
  return { text, source, starts, sentences }
}
export type ReadingTimeline = ReturnType<typeof readingTimeline>

export function sentencePosition(timeline: ReadingTimeline, offset: number, evidence: ReadingPosition['evidence']): ReadingPosition {
  const sentence = timeline.sentences.find(s => offset >= s.start && offset < s.end)
    ?? timeline.sentences.find(s => s.start > offset) ?? timeline.sentences.at(-1)
  const ranges: SourceCharacter[] = []
  // Utterance lifecycle proves coarse position, not which sentence is being spoken.
  if (sentence && evidence === 'boundary') for (const item of timeline.source.slice(sentence.start, sentence.end)) {
    if (!item) continue
    const last = ranges.at(-1)
    if (last && last.pageNumber === item.pageNumber && item.start <= last.end) last.end = Math.max(last.end, item.end)
    else ranges.push({ ...item })
  }
  return { offset, evidence, ranges }
}

export function sentenceSkip(timeline: ReadingTimeline, offset: number, direction: -1 | 1): number {
  const found = timeline.sentences.findIndex(s => offset < s.end)
  const index = found < 0 ? timeline.sentences.length : found
  if (direction === 1) return timeline.sentences[index + 1]?.start ?? timeline.text.length
  return timeline.sentences[Math.max(0, index - 1)]?.start ?? 0
}

/** An explicit seek alone slices the plan. Preserve voices, chunk bounds and provenance. */
export function seekChunks(chunks: readonly SpeechChunk[], offset: number): SpeechChunk[] {
  const timeline = readingTimeline(chunks)
  return chunks.flatMap((chunk, index) => {
    const skip = Math.max(0, offset - timeline.starts[index])
    if (skip >= chunk.text.length) return []
    return [{ ...chunk, text: chunk.text.slice(skip), source: chunk.source?.slice(skip),
      spans: chunk.spans.filter(s => s.end > skip).map(s => ({ ...s, start: Math.max(0, s.start - skip), end: s.end - skip })) }]
  })
}
