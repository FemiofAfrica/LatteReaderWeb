import type { DocumentVoicePlan } from './analysis'
import type { ReadScope } from './playback'
import { mappedSpeech, type SourceCharacter } from './readingPosition'

export interface SourceSpan { pageNumber: number; start: number; end: number }
export interface SpeechChunk { text: string; voiceIndex: number; voiceKey?: string; spans: SourceSpan[]; source?: (SourceCharacter | null)[] }

/** Bounded utterances with character offsets in the actual speech input, not PDF bytes.
 * Page boundaries are whitespace, never sentence terminators. Voice changes are real
 * utterance boundaries. Planning ahead does not advance the displayed page. */
export function planSpeechChunks(pages: readonly string[], fromPage: number, scope: ReadScope,
  plan: DocumentVoicePlan | null = null, maxLength = 1200): SpeechChunk[] {
  maxLength = Math.max(32, Math.floor(maxLength) || 1200)
  let softContinuation = false
  const groups: SpeechChunk[] = []
  const last = scope === 'document' ? pages.length : fromPage
  for (let pageNumber = fromPage; pageNumber <= last; pageNumber += 1) {
    const pageText = pages[pageNumber - 1] ?? ''
    const segments = plan?.segments.filter(s => s.pageNumber === pageNumber)
    const pieces = segments?.length ? segments.map(s => ({ text: s.text,
      voiceIndex: plan?.profiles.find(p => p.id === s.speakerId && p.enabled)?.voiceIndex ?? 0,
      voiceKey: plan?.profiles.find(p => p.id === s.speakerId && p.enabled)?.voiceKey }))
      : [{ text: pageText, voiceIndex: 0, voiceKey: undefined }]
    let cursor = 0
    for (const piece of pieces) {
      // Voice-plan blocks are ordered source substrings. A stale/nonmatching plan must
      // not manufacture positions; its characters remain unmapped.
      const base = pageText.indexOf(piece.text, cursor)
      if (base >= 0) cursor = base + piece.text.length
      const mapped = mappedSpeech(piece.text, pageNumber, Math.max(0, base))
      const text = mapped.text
      if (!text) continue
      let group = groups.at(-1)
      if (!group || group.voiceIndex !== piece.voiceIndex || group.voiceKey !== piece.voiceKey) {
        group = { text: '', voiceIndex: piece.voiceIndex, voiceKey: piece.voiceKey, spans: [], source: [] }; groups.push(group)
      }
      const separator = group.text && !softContinuation ? ' ' : ''
      const start = group.text.length + separator.length
      group.text += `${separator}${text}`
      if (separator) group.source!.push(null)
      for (const item of base >= 0 ? mapped.source : Array(text.length).fill(null)) group.source!.push(item)
      softContinuation = /­\s*$/.test(piece.text)
      group.spans.push({ pageNumber, start, end: group.text.length })
    }
  }
  const chunks: SpeechChunk[] = []
  for (const group of groups) {
    let start = 0
    while (start < group.text.length) {
      const limit = Math.min(start + maxLength, group.text.length)
      let end = limit
      if (limit < group.text.length) {
        const window = group.text.slice(start, limit)
        const stops = [...window.matchAll(/[.!?][”’"']?(?=\s)/g)]
        const sentenceEnd = stops.at(-1)
        const wordEnd = window.lastIndexOf(' ')
        end = sentenceEnd ? start + sentenceEnd.index + sentenceEnd[0].length
          : wordEnd > 0 ? start + wordEnd : limit
      }
      chunks.push({ text: group.text.slice(start, end), voiceIndex: group.voiceIndex, voiceKey: group.voiceKey, source: group.source?.slice(start, end),
        spans: group.spans.filter(s => s.end > start && s.start < end).map(s => ({
          pageNumber: s.pageNumber, start: Math.max(s.start, start) - start, end: Math.min(s.end, end) - start,
        })) })
      start = end
      while (group.text[start] === ' ') start += 1
    }
  }
  return chunks
}
