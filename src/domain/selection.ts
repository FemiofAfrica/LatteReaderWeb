import { readingTimeline, seekChunks } from './readingPosition'
import type { SpeechChunk } from './speechPlan'

export interface SourceSelection { pageNumber: number; start: number; end: number }

/** DOM Range offsets, never indexOf(selected text). Both ends must be in one source container. */
export function sourceSelection(selection: Selection | null): SourceSelection | null {
  if (!selection?.rangeCount || selection.isCollapsed) return null
  const range = selection.getRangeAt(0)
  const element = range.startContainer instanceof Element ? range.startContainer : range.startContainer.parentElement
  const container = element?.closest<HTMLElement>('.page-text[data-source-page]')
  if (!container || !container.contains(range.endContainer)) return null
  const prefix = range.cloneRange()
  prefix.selectNodeContents(container)
  prefix.setEnd(range.startContainer, range.startOffset)
  const start = prefix.toString().length
  const end = start + range.toString().length
  if (!range.toString().trim()) return null
  return { pageNumber: Number(container.dataset.sourcePage), start, end }
}

/** Slice existing bounded, voiced chunks by provenance, including expanded glyphs. */
export function selectionChunks(chunks: readonly SpeechChunk[], selected: SourceSelection, toEnd: boolean): SpeechChunk[] {
  const timeline = readingTimeline(chunks)
  const start = timeline.source.findIndex(s => s?.pageNumber === selected.pageNumber && s.end > selected.start)
  if (start < 0) return []
  if (toEnd) return seekChunks(chunks, start)
  let end = start
  while (end < timeline.source.length) {
    const source = timeline.source[end]
    if (source && (source.pageNumber !== selected.pageNumber || source.start >= selected.end)) break
    end++
  }
  return chunks.flatMap((chunk, index) => {
    const left = Math.max(0, start - timeline.starts[index])
    const right = Math.min(chunk.text.length, end - timeline.starts[index])
    if (right <= left) return []
    return [{ ...chunk, text: chunk.text.slice(left, right), source: chunk.source?.slice(left, right),
      spans: chunk.spans.filter(s => s.end > left && s.start < right).map(s => ({ ...s, start: Math.max(left, s.start) - left, end: Math.min(right, s.end) - left })) }]
  })
}
