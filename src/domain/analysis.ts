export type SegmentKind = 'narrator' | 'dialogue' | 'explicitSpeaker' | 'heading'

export interface ReadingSegment {
  id: string
  text: string
  pageNumber: number
  kind: SegmentKind
  speakerId: string
  confidence: number
}

export interface VoiceProfile {
  id: string
  displayName: string
  aliases: string[]
  confidence: number
  voiceIndex: number
  enabled: boolean
}

export interface DocumentVoicePlan {
  schemaVersion: 1
  documentId: string
  documentName: string
  profiles: VoiceProfile[]
  segments: ReadingSegment[]
}

const attributionPattern = /\b([A-Z][a-z]+(?:\s+[A-Z][a-z]+){0,2})\s+(?:said|asked|replied|cried|whispered|shouted|answered|muttered|called|continued|added|exclaimed)\b/g
const reverseAttributionPattern = /\b(?:said|asked|replied|cried|whispered|shouted|answered|muttered|called|continued|added|exclaimed)\s+([A-Z][a-z]+(?:\s+[A-Z][a-z]+){0,2})\b/g
const explicitPattern = /^\s*([A-Z][A-Z0-9 .'-]{1,38}|[A-Z][a-z]+(?:\s+[A-Z][a-z]+){0,2})\s*[:-]\s+/
const blockedNames = new Set([
  'I', 'Me', 'My', 'Mine', 'We', 'Us', 'Our', 'You', 'Your', 'He', 'Him', 'His', 'She', 'Her', 'They', 'Them',
  'The', 'A', 'An', 'This', 'That', 'There', 'Then', 'When', 'Where', 'Why', 'How', 'From', 'Into', 'Onto',
  'Chapter', 'Page', 'Figure', 'Table', 'Act', 'Scene', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday', 'Sunday',
])

const normalizeName = (value: string) => value
  .trim()
  .replace(/^[:\-.,;!?"“”\s]+|[:\-.,;!?"“”\s]+$/g, '')
  .replace(/\s+/g, ' ')

const displayName = (value: string) => normalizeName(value)
  .toLowerCase()
  .replace(/\b\w/g, (letter) => letter.toUpperCase())

const speakerId = (value: string) => normalizeName(value).toLowerCase().replace(/[^a-z0-9]+/g, '-')

function likelyName(value: string): boolean {
  const name = displayName(value)
  if (blockedNames.has(name) || name.length < 2 || name.length > 40) return false
  const words = name.split(' ')
  return words.length <= 3 && words.every((word) => /^[A-Z][a-z'-]+$/.test(word))
}

function explicitSpeaker(text: string): string | null {
  return text.match(explicitPattern)?.[1] ?? null
}

function attributions(text: string): string[] {
  return [
    ...Array.from(text.matchAll(attributionPattern), (match) => match[1]),
    ...Array.from(text.matchAll(reverseAttributionPattern), (match) => match[1]),
  ]
}

function classify(text: string): SegmentKind {
  if (explicitSpeaker(text)) return 'explicitSpeaker'
  if (/["“”]/.test(text) || /^-\s+/.test(text)) return 'dialogue'
  if (text.length < 90 && /[A-Z]/.test(text) && text === text.toUpperCase()) return 'heading'
  return 'narrator'
}

export function segmentPages(pages: string[]): ReadingSegment[] {
  return pages.flatMap((page, pageIndex) => page
    .split(/\n|\u2029| {2,}/)
    .map((block) => block.trim())
    .filter(Boolean)
    .map((text, blockIndex) => {
      const kind = classify(text)
      return {
        id: `${pageIndex + 1}-${blockIndex + 1}`,
        text,
        pageNumber: pageIndex + 1,
        kind,
        speakerId: 'narrator',
        confidence: kind === 'narrator' ? 0.9 : 0.35,
      }
    }))
}

export function analyzeDocument(documentId: string, documentName: string, pages: string[]): DocumentVoicePlan {
  const segments = segmentPages(pages)
  const scores = new Map<string, { name: string; aliases: Set<string>; score: number }>()

  const add = (rawName: string, score: number) => {
    if (!likelyName(rawName)) return
    const name = displayName(rawName)
    const id = speakerId(name)
    const found = scores.get(id) ?? { name, aliases: new Set<string>(), score: 0 }
    found.aliases.add(name)
    found.score += score
    scores.set(id, found)
  }

  for (const segment of segments) {
    const explicit = explicitSpeaker(segment.text)
    if (explicit) add(explicit, 1)
    for (const name of attributions(segment.text)) add(name, segment.kind === 'dialogue' ? 0.7 : 0.45)
  }

  const profiles: VoiceProfile[] = [{
    id: 'narrator',
    displayName: 'Narrator',
    aliases: [],
    confidence: 1,
    voiceIndex: 0,
    enabled: true,
  }]

  Array.from(scores.entries())
    .filter(([, data]) => data.score >= 1.2)
    .sort(([a], [b]) => a.localeCompare(b))
    .slice(0, 5)
    .forEach(([id, data], index) => profiles.push({
      id,
      displayName: data.name,
      aliases: Array.from(data.aliases).sort(),
      confidence: Math.min(0.98, data.score / 2),
      voiceIndex: index + 1,
      enabled: true,
    }))

  const known = new Set(profiles.map(({ id }) => id))
  const assigned = segments.map((segment) => {
    const explicit = explicitSpeaker(segment.text)
    const attributed = attributions(segment.text)[0]
    const candidate = explicit ?? attributed
    const id = candidate ? speakerId(candidate) : 'narrator'
    if (!known.has(id)) return segment
    return { ...segment, speakerId: id, confidence: explicit ? 0.95 : 0.65 }
  })

  return { schemaVersion: 1, documentId, documentName, profiles, segments: assigned }
}

export function chunkText(text: string, maxLength = 3500): string[] {
  const normalized = text.replace(/\s*\n\s*/g, ' ').replace(/\s+/g, ' ').trim()
  if (!normalized) return []
  const sentences = normalized.match(/[^.!?]+[.!?]+|[^.!?]+$/g)?.map((value) => value.trim()) ?? []
  const chunks: string[] = []
  let current = ''
  for (const sentence of sentences) {
    if (sentence.length > maxLength) {
      if (current) chunks.push(current)
      for (let index = 0; index < sentence.length; index += maxLength) {
        chunks.push(sentence.slice(index, index + maxLength).trim())
      }
      current = ''
      continue
    }
    const candidate = current ? `${current} ${sentence}` : sentence
    if (candidate.length > maxLength && current) {
      chunks.push(current)
      current = sentence
    } else {
      current = candidate
    }
  }
  if (current) chunks.push(current)
  return chunks
}
