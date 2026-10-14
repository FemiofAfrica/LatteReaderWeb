export type PlaybackStatus = 'ready' | 'playing' | 'paused'
export type ReadScope = 'selection' | 'page' | 'document'

export interface PlaybackState {
  status: PlaybackStatus
  scope: ReadScope
  page: number
  message: string
}

export type PlaybackAction =
  | { type: 'PLAY'; scope: ReadScope; page?: number }
  | { type: 'WAIT'; scope: ReadScope; page: number }
  | { type: 'ADVANCE'; page: number; totalPages: number }
  | { type: 'SEEK'; page: number }
  | { type: 'PAUSE' }
  | { type: 'RESUME' }
  | { type: 'STOP' }
  | { type: 'END' }
  | { type: 'FAIL'; message: string }

export const initialPlaybackState: PlaybackState = {
  status: 'ready',
  scope: 'document',
  page: 0,
  message: 'Ready to read',
}

function scopeMessage(scope: ReadScope): string {
  if (scope === 'page') return 'Reading this page'
  if (scope === 'selection') return 'Reading selection'
  return 'Reading to the end of the document'
}

export function playbackReducer(state: PlaybackState, action: PlaybackAction): PlaybackState {
  switch (action.type) {
    case 'PLAY': return { status: 'playing', scope: action.scope, page: action.page ?? state.page, message: scopeMessage(action.scope) }
    case 'WAIT': return { status: 'playing', scope: action.scope, page: action.page, message: 'Waiting for text extraction before continuous reading' }
    case 'ADVANCE': return { ...state, status: 'playing', page: action.page, message: `Reading page ${action.page} of ${action.totalPages}` }
    case 'SEEK': return { ...state, page: action.page, message: `${state.status === 'paused' ? 'Paused' : state.status === 'playing' ? 'Reading' : 'Ready'} on page ${action.page}` }
    case 'PAUSE': return { ...state, status: 'paused', message: 'Playback paused' }
    case 'RESUME': return { ...state, status: 'playing', message: scopeMessage(state.scope) }
    case 'END': return { ...state, status: 'ready', page: 0, message: state.scope === 'document' ? 'Finished the document' : 'Reading complete' }
    case 'FAIL': return { ...state, status: 'ready', message: action.message }
    case 'STOP': return initialPlaybackState
  }
}

export interface ReadingStep {
  pageNumber: number
  text: string
}

export function hasReadableText(value: string | undefined): boolean {
  return typeof value === 'string' && value.trim().length > 0
}

/**
 * The ordered pages to read from `fromPage`. Continuous scope walks to the end of the
 * document; page scope stops at the starting page. Pages with no readable text are skipped
 * so a blank page cannot stall the sequence.
 */
export function buildReadingSteps(pages: readonly string[], fromPage: number, scope: ReadScope): ReadingStep[] {
  const start = Number.isFinite(fromPage) ? Math.max(1, Math.floor(fromPage)) : 1
  const last = scope === 'document' ? pages.length : start
  const steps: ReadingStep[] = []
  for (let page = start; page <= last; page += 1) {
    const text = pages[page - 1]
    if (hasReadableText(text)) steps.push({ pageNumber: page, text: text as string })
  }
  return steps
}

export function buildReadingPages(pages: readonly string[], fromPage: number, scope: ReadScope): number[] {
  return buildReadingSteps(pages, fromPage, scope).map((step) => step.pageNumber)
}

/** The first page after `afterPage` that has readable text, or null at the end of the document. */
export function nextReadablePage(pages: readonly string[], afterPage: number): number | null {
  const start = Math.max(1, Math.floor(afterPage) + 1)
  for (let page = start; page <= pages.length; page += 1) {
    if (hasReadableText(pages[page - 1])) return page
  }
  return null
}

/**
 * The next page the engine should read, given the page it is reading right now. Null when
 * the run must stop: not playing (stopped or paused keeps position), a single-page scope at
 * its boundary, or the final readable page already read.
 *
 * The current page is passed explicitly rather than read from the reducer state, because a
 * page can finish before React has re-rendered the latest state.
 */
export function advancePage(pages: readonly string[], state: PlaybackState, currentPage: number): number | null {
  if (state.status !== 'playing') return null
  if (state.scope !== 'document') return null
  return nextReadablePage(pages, currentPage)
}

export function nextReadingPage(pages: readonly string[], state: PlaybackState): number | null {
  return advancePage(pages, state, state.page)
}
