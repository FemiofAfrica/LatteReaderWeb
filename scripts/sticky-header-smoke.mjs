// Pinned mobile chrome smoke.
//
// The product bar and the preview header must stay against the top of the viewport while the
// page scrolls, at every phone and small-tablet width, including the 504px embedded pane.
// The two are flush (one divider line, no gap and no overlap), opaque (the pinned pixels do
// not change while the content behind them scrolls), and they never cost the reader a line:
// every tracked element is scrolled to and measured with its top edge clear of the pinned band
// and its bottom edge clear of the fixed bottom bar. Desktop keeps the console it had.
import { chromium } from 'playwright'
import { fileURLToPath } from 'node:url'
import { createHash } from 'node:crypto'
import path from 'node:path'

const root = path.dirname(path.dirname(fileURLToPath(import.meta.url)))
const fixture = path.join(root, 'tests/fixtures/latte-reader-text-fixture.pdf')
const baseURL = process.env.LATTE_READER_URL ?? 'http://127.0.0.1:4176/'
const MOBILE = [
  { width: 360, height: 844 },
  { width: 390, height: 844 },
  { width: 414, height: 896 },
  { width: 504, height: 900 },
  { width: 768, height: 1024 },
]
const DESKTOP = [
  { width: 1100, height: 900 },
  { width: 1440, height: 1000 },
]

const browser = await chromium.launch({ headless: true })
const failures = []
const check = (condition, message) => { if (!condition) failures.push(message) }
const sha = (buffer) => createHash('sha256').update(buffer).digest('hex').slice(0, 16)
const settle = async (page) => {
  await page.evaluate(() => new Promise((resolve) => requestAnimationFrame(() => requestAnimationFrame(resolve))))
  await page.waitForTimeout(120)
}

const openFixture = async (page) => {
  await page.goto(baseURL, { waitUntil: 'networkidle' })
  await page.getByRole('heading', { name: 'Choose a PDF to begin' }).waitFor()
  await page.locator('input[type=file]').setInputFiles(fixture)
  await page.waitForFunction(() => document.body.textContent?.includes('Extraction complete'), undefined, { timeout: 20000 })
  await page.locator('.page-stage canvas').waitFor({ timeout: 20000 })
  await settle(page)
}
const selectPanel = async (page, name) => {
  if (await page.getByRole('tab', { name }).count()) await page.getByRole('tab', { name }).click()
  await settle(page)
}
const setTranscript = async (page, open) => {
  const isOpen = await page.locator('.page-text-disclosure').evaluate((node) => node.hasAttribute('open'))
  if (isOpen !== open) await page.locator('.page-text-disclosure summary').click()
  await settle(page)
}
const scrollTo = async (page, y) => { await page.evaluate((value) => window.scrollTo(0, value), y); await settle(page) }

// Geometry of the pinned chrome, the fixed bar and the page at the current scroll position.
const chrome = (page) => page.evaluate(() => {
  const info = (sel) => {
    const el = document.querySelector(sel)
    if (!el) return null
    const box = el.getBoundingClientRect()
    const style = getComputedStyle(el)
    return {
      top: Math.round(box.top), bottom: Math.round(box.bottom), height: Math.round(box.height),
      position: style.position, zIndex: style.zIndex, backgroundColor: style.backgroundColor, backgroundImage: style.backgroundImage,
      borderTop: style.borderTopWidth, borderBottom: style.borderBottomWidth, borderRadius: style.borderTopLeftRadius,
      overflow: style.overflow,
      visible: style.display !== 'none' && box.width > 0 && box.height > 0,
    }
  }
  const doc = document.documentElement
  return {
    viewportWidth: window.innerWidth,
    viewportHeight: window.innerHeight,
    scrollY: Math.round(window.scrollY),
    maxScroll: Math.round(doc.scrollHeight - window.innerHeight),
    deck: info('.reader-deck'),
    topbar: info('.topbar'),
    previewHeader: info('.preview-header'),
    mobileBar: info('.mobile-bar'),
    transport: info('.transport'),
    topbarHeightVar: getComputedStyle(doc).getPropertyValue('--mobile-topbar-height').trim(),
  }
})

// Every tracked in-flow element, measured against the pinned band and the fixed bar.
const contentEdges = (page, selectors) => page.evaluate((list) => {
  const box = (sel) => {
    const el = document.querySelector(sel)
    if (!el) return null
    const rect = el.getBoundingClientRect()
    if (rect.width === 0 && rect.height === 0) return null
    if (getComputedStyle(el).display === 'none') return null
    return rect
  }
  const topbar = box('.topbar')
  const header = box('.preview-header')
  const bandBottom = header ? Math.max(topbar.bottom, header.bottom) : topbar.bottom
  const bar = box('.mobile-bar')
  const clearBottom = bar ? bar.top : window.innerHeight
  const maxScroll = document.documentElement.scrollHeight - window.innerHeight
  const scrollY = window.scrollY
  return {
    bandBottom, clearBottom, maxScroll, scrollY,
    items: list.map((sel) => {
      const rect = box(sel)
      if (!rect) return { sel, present: false }
      return { sel, present: true, docTop: rect.top + scrollY, docBottom: rect.bottom + scrollY, height: rect.height }
    }).filter((item) => item.present),
  }
}, selectors)

// Scrolls so the element's own top edge sits just under the pinned band, and so its bottom edge
// sits just above the fixed bar, measuring the real rect at each stop. This is the direct proof
// that no line the reader needs is trapped behind pinned chrome.
const proveReachable = (page, selectors) => page.evaluate(async (list) => {
  const box = (sel) => {
    const el = document.querySelector(sel)
    if (!el) return null
    const rect = el.getBoundingClientRect()
    if (rect.width === 0 && rect.height === 0) return null
    if (getComputedStyle(el).display === 'none') return null
    return rect
  }
  const settle = () => new Promise((resolve) => requestAnimationFrame(() => requestAnimationFrame(resolve)))
  const topbar = box('.topbar')
  const header = box('.preview-header')
  const bandBottom = header ? Math.max(topbar.bottom, header.bottom) : topbar.bottom
  const bar = box('.mobile-bar')
  const clearBottom = bar ? bar.top : window.innerHeight
  const maxScroll = document.documentElement.scrollHeight - window.innerHeight
  const start = window.scrollY
  const clamp = (value) => Math.max(0, Math.min(Math.round(value), Math.round(maxScroll)))
  const out = []
  for (const sel of list) {
    const rect = box(sel)
    if (!rect) { out.push({ sel, present: false }); continue }
    const docTop = rect.top + start
    const docBottom = rect.bottom + start
    const sTop = clamp(docTop - bandBottom)
    window.scrollTo(0, sTop)
    await settle()
    const atTop = box(sel)?.top ?? null
    const sBottom = clamp(docBottom - clearBottom)
    window.scrollTo(0, sBottom)
    await settle()
    const atBottom = box(sel)?.bottom ?? null
    window.scrollTo(0, start)
    await settle()
    out.push({
      sel, present: true,
      height: Math.round(rect.height),
      topStop: { scroll: sTop, measuredTop: atTop === null ? null : Math.round(atTop), clear: atTop !== null && atTop >= bandBottom - 1 && atTop < window.innerHeight },
      bottomStop: { scroll: sBottom, measuredBottom: atBottom === null ? null : Math.round(atBottom), clear: atBottom !== null && atBottom <= clearBottom + 1 && atBottom > 0 },
      fitsClearBand: rect.height <= clearBottom - bandBottom + 1,
    })
  }
  return { bandBottom: Math.round(bandBottom), clearBottom: Math.round(clearBottom), clearBand: Math.round(clearBottom - bandBottom), maxScroll: Math.round(maxScroll), items: out }
}, selectors)

// A wrapped paragraph reports one client rect per line box, so this counts whole lines that sit
// completely inside the clear region between the pinned band and the fixed bar.
const transcriptLines = (page) => page.evaluate(() => {
  const topbar = document.querySelector('.topbar').getBoundingClientRect()
  const header = document.querySelector('.preview-header')
  const bandBottom = header && getComputedStyle(header).display !== 'none' ? Math.max(topbar.bottom, header.getBoundingClientRect().bottom) : topbar.bottom
  const bar = document.querySelector('.mobile-bar')?.getBoundingClientRect()
  const clearBottom = bar ? bar.top : window.innerHeight
  const paragraph = document.querySelector('.page-text p')
  if (!paragraph || !paragraph.firstChild) return { lines: 0, fullyVisible: 0 }
  const range = document.createRange()
  range.selectNodeContents(paragraph)
  const scroller = document.querySelector('.page-text').getBoundingClientRect()
  const rects = [...range.getClientRects()].filter((rect) => rect.bottom > scroller.top - 1 && rect.top < scroller.bottom + 1 && rect.bottom - rect.top > 2)
  return { lines: rects.length, fullyVisible: rects.filter((rect) => rect.top >= bandBottom - 1 && rect.bottom <= clearBottom + 1).length }
})

// A pinned surface is opaque when its own pixels do not change while the content behind it
// scrolls. rgba alpha alone would not prove that, so the screenshot is compared.
const opaque = (style) => {
  const match = style.backgroundColor.match(/rgba?\(([^)]+)\)/)
  if (!match) return false
  const parts = match[1].split(',').map((value) => value.trim())
  const alpha = parts.length === 4 ? Number(parts[3]) : 1
  return alpha === 1 && style.backgroundImage === 'none'
}

// Content the pinned chrome must never trap. The zoom and fit controls live inside the preview
// header itself, so they move with it and are excluded here; they are proved usable by the
// pointer check on the fit control instead.
const TRACKERS = ['.page-stage canvas', '.page-text-disclosure', '.page-text p']
const DOC_TRACKERS = ['progress', '.delete-button']

const mobileReport = {}
const desktopReport = {}

for (const viewport of MOBILE) {
  const label = `${viewport.width}x${viewport.height}`
  const page = await browser.newPage({ viewport })
  await openFixture(page)
  await selectPanel(page, 'Read')

  // 1. The natural state, transcript closed.
  await setTranscript(page, false)
  await scrollTo(page, 0)
  const closedRest = await chrome(page)
  if (closedRest.maxScroll > 0) {
    await scrollTo(page, Math.round(closedRest.maxScroll / 2))
    const closedMid = await chrome(page)
    await scrollTo(page, closedRest.maxScroll)
    const closedBottom = await chrome(page)
    for (const [name, state] of [['mid', closedMid], ['bottom', closedBottom]]) {
      check(state.topbar.top === 0, `${label} closed ${name}: the product bar is at ${state.topbar.top} instead of the top`)
      check(state.previewHeader.top === state.topbar.bottom, `${label} closed ${name}: the preview header top (${state.previewHeader.top}) is not flush with the bar bottom (${state.topbar.bottom})`)
    }
  }

  // 2. Transcript open: long enough to scroll at every mobile width.
  await setTranscript(page, true)
  await scrollTo(page, 0)
  const rest = await chrome(page)
  check(rest.maxScroll > 0, `${label}: the preview page does not scroll, so pinning cannot be proved`)
  check(rest.topbar.top === 0, `${label} rest: the product bar is at ${rest.topbar.top} instead of the top`)
  check(rest.topbar.position === 'sticky' && rest.previewHeader.position === 'sticky', `${label}: the headers are not pinned (${rest.topbar.position}/${rest.previewHeader.position})`)
  check(rest.previewHeader.top === rest.topbar.bottom && rest.previewHeader.top === rest.topbar.height, `${label}: the preview header is not flush under the bar (${rest.previewHeader.top} vs ${rest.topbar.bottom})`)
  check(opaque(rest.topbar) && opaque(rest.previewHeader), `${label}: a pinned header is not opaque (${rest.topbar.backgroundColor} / ${rest.previewHeader.backgroundColor})`)
  check(Number(rest.topbar.zIndex) > Number(rest.previewHeader.zIndex) && Number(rest.previewHeader.zIndex) > 0, `${label}: the pinned stacking order is wrong (${rest.topbar.zIndex}/${rest.previewHeader.zIndex})`)
  check(rest.topbar.borderTop === '0px' && rest.topbar.borderBottom === '1px', `${label}: the product bar carries ${rest.topbar.borderTop}/${rest.topbar.borderBottom} borders`)
  check(rest.previewHeader.borderTop === '0px' && rest.previewHeader.borderBottom === '1px', `${label}: the preview header carries ${rest.previewHeader.borderTop}/${rest.previewHeader.borderBottom} borders`)
  check(rest.topbarHeightVar === `${rest.topbar.height}px`, `${label}: the measured bar height variable reads "${rest.topbarHeightVar}" for a ${rest.topbar.height}px bar`)

  // Nothing sits under the pinned band at the reader's natural stop.
  const edges = await contentEdges(page, TRACKERS)
  for (const item of edges.items) {
    check(item.docTop >= edges.bandBottom - 1, `${label}: ${item.sel} starts under the pinned headers at rest (top ${Math.round(item.docTop)} vs band ${Math.round(edges.bandBottom)})`)
  }

  // 3. Pinned and opaque while the content moves behind it.
  const band = Math.round(edges.bandBottom)
  await scrollTo(page, Math.round(rest.maxScroll / 2))
  const mid = await chrome(page)
  const midBand = sha(await page.screenshot({ clip: { x: 0, y: 0, width: viewport.width, height: band } }))
  const midView = sha(await page.screenshot())
  if (viewport.width === 504) await page.screenshot({ path: path.join(root, 'tests/artifacts/mobile-pinned-header-504x900-mid.png') })
  await scrollTo(page, rest.maxScroll)
  const bottom = await chrome(page)
  const bottomBand = sha(await page.screenshot({ clip: { x: 0, y: 0, width: viewport.width, height: band } }))
  const bottomView = sha(await page.screenshot())
  if (viewport.width === 504) await page.screenshot({ path: path.join(root, 'tests/artifacts/mobile-pinned-header-504x900-bottom.png') })

  for (const [name, state] of [['mid', mid], ['bottom', bottom]]) {
    check(state.topbar.top === 0, `${label} ${name}: the product bar left the top (${state.topbar.top})`)
    check(state.topbar.bottom <= state.viewportHeight, `${label} ${name}: the product bar bottom (${state.topbar.bottom}) is off screen`)
    check(state.previewHeader.top === state.topbar.bottom, `${label} ${name}: the preview header top (${state.previewHeader.top}) is not flush with the bar bottom (${state.topbar.bottom})`)
    check(state.previewHeader.bottom <= state.viewportHeight, `${label} ${name}: the preview header bottom (${state.previewHeader.bottom}) is off screen`)
  }
  check(midBand === bottomBand, `${label}: the pinned band pixels changed while scrolling (${midBand} vs ${bottomBand})`)
  check(midView !== bottomView, `${label}: the page looked identical at two scroll positions, so the pin was not exercised`)

  // 4. Nothing is covered: each tracked element is scrolled to and measured clear.
  const reach = await proveReachable(page, TRACKERS)
  for (const item of reach.items) {
    if (!item.present) continue
    check(item.topStop.clear, `${label}: ${item.sel} top edge is under the pinned band at its top stop (top ${item.topStop.measuredTop} vs band ${reach.bandBottom})`)
    check(item.bottomStop.clear, `${label}: ${item.sel} bottom edge is behind the fixed bar at its bottom stop (bottom ${item.bottomStop.measuredBottom} vs bar ${reach.clearBottom})`)
  }

  // 5. A whole transcript line and the page controls stay usable at the bottom of the scroll.
  await scrollTo(page, rest.maxScroll)
  const lines = await transcriptLines(page)
  check(lines.fullyVisible >= 1, `${label}: no full transcript line is visible at the bottom of the scroll (${lines.lines} lines drawn)`)
  await page.locator('.fit-width-button').click({ trial: true })
  await page.getByRole('button', { name: 'Next page' }).click({ trial: true })
  await page.locator('.page-jump input').click({ trial: true })
  const pinnedControls = await page.evaluate(() => [...document.querySelectorAll('.page-stepper button, .page-jump input')].every(node => {
    const r = node.getBoundingClientRect(), h = document.querySelector('.preview-header').getBoundingClientRect()
    return r.top >= h.top && r.bottom <= h.bottom && node.contains(document.elementFromPoint(r.left + r.width / 2, r.top + r.height / 2))
  }))
  check(pinnedControls, `${label}: page navigation is not reachable inside the pinned header`)
  if (viewport.width === 504) await page.screenshot({ path: path.join(root, 'tests/artifacts/mobile-pinned-header-504x900-bottom.png') })

  // 6. The other mobile panels keep the pinned bar and render no preview header.
  await selectPanel(page, 'Document')
  await page.locator('.document-details summary').click()
  await scrollTo(page, 0)
  const docRest = await chrome(page)
  check(docRest.topbar.position === 'sticky' && docRest.topbar.top === 0, `${label}: the product bar is not pinned in the Document panel`)
  check(docRest.previewHeader.visible === false, `${label}: the preview header rendered in the Document panel`)
  const docEdges = await contentEdges(page, DOC_TRACKERS)
  for (const item of docEdges.items) {
    check(item.docTop >= docEdges.bandBottom - 1, `${label} document: ${item.sel} starts under the pinned headers (top ${Math.round(item.docTop)} vs band ${Math.round(docEdges.bandBottom)})`)
  }
  await scrollTo(page, docRest.maxScroll)
  const docBottom = await chrome(page)
  check(docBottom.topbar.top === 0, `${label} document: the product bar left the top (${docBottom.topbar.top})`)
  await page.screenshot({ path: path.join(root, `tests/artifacts/mobile-pinned-header-document-${viewport.width}.png`) })

  // 7. The offset follows the bar: after a viewport change the two are still flush and the
  // measured variable matches the bar's new height.
  if (viewport.width === 390) {
    await selectPanel(page, 'Read')
    await page.setViewportSize({ width: 768, height: 1024 })
    await settle(page)
    await scrollTo(page, 0)
    const resized = await chrome(page)
    check(resized.topbar.top === 0, `${label} after resize: the product bar is at ${resized.topbar.top} instead of the top`)
    check(resized.previewHeader.top === resized.topbar.bottom, `${label} after resize: the preview header top (${resized.previewHeader.top}) is not flush with the bar bottom (${resized.topbar.bottom})`)
    check(resized.topbarHeightVar === `${resized.topbar.height}px`, `${label} after resize: the measured bar height reads "${resized.topbarHeightVar}" for a ${resized.topbar.height}px bar`)
    await scrollTo(page, resized.maxScroll)
    const resizedBottom = await chrome(page)
    check(resizedBottom.topbar.top === 0 && resizedBottom.previewHeader.top === resizedBottom.topbar.bottom, `${label} after resize: the headers are not pinned at the bottom of the scroll`)
    mobileReport[`${label} resized to 768x1024`] = {
      topbarHeight: resized.topbar.height, measuredVariable: resized.topbarHeightVar,
      topbarTop: { rest: resized.topbar.top, bottom: resizedBottom.topbar.top },
      previewHeaderTop: { rest: resized.previewHeader.top, bottom: resizedBottom.previewHeader.top },
      gap: resizedBottom.previewHeader.top - resizedBottom.topbar.bottom,
    }
  }

  mobileReport[label] = {
    closedTranscript: { maxScroll: closedRest.maxScroll },
    topbar: { height: rest.topbar.height, measuredVariable: rest.topbarHeightVar, background: rest.topbar.backgroundColor, borderTop: rest.topbar.borderTop, borderBottom: rest.topbar.borderBottom },
    previewHeader: { height: rest.previewHeader.height, top: rest.previewHeader.top, rest: rest.previewHeader.top, mid: mid.previewHeader.top, bottom: bottom.previewHeader.top, background: rest.previewHeader.backgroundColor },
    maxScroll: rest.maxScroll,
    topbarTop: { rest: rest.topbar.top, mid: mid.topbar.top, bottom: bottom.topbar.top },
    gapAtMid: mid.previewHeader.top - mid.topbar.bottom,
    opaqueBand: { mid: midBand, bottom: bottomBand, identical: midBand === bottomBand, viewportMoved: midView !== bottomView },
    clearBand: reach.clearBand,
    transcriptLinesAtBottom: lines,
    reachable: reach.items.map((item) => item.present === false
      ? { sel: item.sel, present: false }
      : { sel: item.sel, present: true, height: item.height, topStop: item.topStop, bottomStop: item.bottomStop, fitsClearBand: item.fitsClearBand }),
  }
  await page.close()
}

for (const viewport of DESKTOP) {
  const label = `${viewport.width}x${viewport.height}`
  const page = await browser.newPage({ viewport })
  await openFixture(page)
  await selectPanel(page, 'Read')
  await setTranscript(page, true)
  await scrollTo(page, 0)
  const rest = await chrome(page)
  await page.locator('.preview-scroll').evaluate(el => { el.scrollTop = 100 })
  await settle(page)
  const mid = await chrome(page)
  await page.locator('.preview-scroll').evaluate(el => { el.scrollTop = el.scrollHeight })
  await settle(page)
  const bottom = await chrome(page)

  check(rest.topbar.position === 'static', `${label}: the product bar is ${rest.topbar.position} on desktop`)
  check(rest.previewHeader.position === 'static', `${label}: the preview header is ${rest.previewHeader.position} on desktop`)
  check(rest.deck.borderRadius === '24px', `${label}: the console bezel radius changed to ${rest.deck.borderRadius}`)
  check(rest.deck.overflow === 'hidden', `${label}: the desktop deck overflow changed to ${rest.deck.overflow}`)
  check(rest.previewHeader.backgroundColor === 'rgb(44, 34, 26)', `${label}: the reader toolbar lost its opaque chrome surface`)
  const innerScroll = await page.locator('.preview-scroll').evaluate(el => el.scrollTop)
  check(rest.maxScroll === 0 && innerScroll > 0, `${label}: document scroll ownership failed (${rest.maxScroll} outer / ${innerScroll} inner)`)
  check(rest.topbar.top === mid.topbar.top && mid.topbar.top === bottom.topbar.top && rest.previewHeader.top === bottom.previewHeader.top, `${label}: desktop chrome moved with preview scroll`)
  check(rest.topbarHeightVar === '', `${label}: the mobile header offset variable leaked onto desktop ("${rest.topbarHeightVar}")`)
  check(!rest.mobileBar && rest.transport.visible, `${label}: the desktop console controls changed`)
  const full = await page.screenshot({ path: path.join(root, `tests/artifacts/desktop-console-${viewport.width}.png`), fullPage: true })

  desktopReport[label] = {
    topbar: { position: rest.topbar.position, background: rest.topbar.backgroundColor },
    previewHeader: { position: rest.previewHeader.position, background: rest.previewHeader.backgroundColor },
    deck: { radius: rest.deck.borderRadius, overflow: rest.deck.overflow },
    scroll: { rest: rest.topbar.top, mid: mid.topbar.top, bottom: bottom.topbar.top, maxScroll: rest.maxScroll },
    headerGapAtMid: mid.previewHeader.top - mid.topbar.bottom,
    fullPageHash: sha(full),
  }
  await page.close()
}

await browser.close()
const report = { status: failures.length ? 'failed' : 'passed', mobile: mobileReport, desktop: desktopReport }
if (failures.length) {
  console.error(JSON.stringify({ ...report, failures }, null, 2))
  process.exit(1)
}
console.log(JSON.stringify({
  status: 'passed',
  verified: [
    'the product bar and the preview header stay at the top of the viewport while the page scrolls at 360, 390, 414, 504 and 768',
    'the preview header sits flush under the bar, with the bar offset by its measured height',
    'the two pinned headers are opaque: their pixels are unchanged while the content behind them scrolls',
    'one divider line, no doubled border and no gap between them',
    'no tracked content element starts under the pinned band at rest',
    'every tracked element is scrolled to and measured clear of the pinned band and the fixed bar',
    'a whole transcript line and the page controls stay usable at the bottom of the scroll',
    'the other mobile panels keep the pinned bar and render no preview header',
    'desktop chrome is anchored in a viewport-bound console while only the preview scrolls',
  ],
  mobile: mobileReport,
  desktop: desktopReport,
}, null, 2))
