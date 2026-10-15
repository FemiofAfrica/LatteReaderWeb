import type { SpeechChunk } from '../domain/speechPlan'
export interface LocalPart { text: string; chunk: number; start: number; end: number; page: number; pageEnd: number }
/** Exact slices of already mapped speech. Never truncate an overlong word. */
export function localParts(chunks: readonly SpeechChunk[]): LocalPart[] {
  return chunks.flatMap((c, chunk) => {
    const parts: LocalPart[] = []
    for (let start = 0; start < c.text.length;) {
      let end = Math.min(start + 250, c.text.length)
      const window = c.text.slice(start, end)
      const sentence = /[.!?][”’"']?(?=\s|$)/g.exec(window)
      if (sentence) end = start + sentence.index + sentence[0].length
      else if (end < c.text.length) {
        if (window.lastIndexOf(' ') > 0) end = start + window.lastIndexOf(' ') + 1
        else { const next = c.text.indexOf(' ', end); end = next < 0 ? c.text.length : next + 1 }
      }
      if (/[\uD800-\uDBFF]/.test(c.text[end - 1]) && /[\uDC00-\uDFFF]/.test(c.text[end] ?? '')) end--
      const spans = c.spans.filter(s => s.end > start && s.start < end)
      parts.push({ text:c.text.slice(start,end),chunk,start,end,page:spans[0]?.pageNumber ?? 1,pageEnd:spans.at(-1)?.pageNumber ?? 1 })
      start=end
    }
    return parts
  })
}
