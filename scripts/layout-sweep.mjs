// Layout sweep: at every required width the page must not scroll horizontally, and the
// mobile bottom bar must stay inside the viewport without covering page content.
import { chromium } from 'playwright'
import { fileURLToPath } from 'node:url'
import path from 'node:path'

const root = path.dirname(path.dirname(fileURLToPath(import.meta.url)))
const fixture = path.join(root, 'tests/fixtures/latte-reader-text-fixture.pdf')
const baseURL = process.env.LATTE_READER_URL ?? 'http://127.0.0.1:4176/'
const WIDTHS = [
  { width: 360, height: 844, mobile: true },
  { width: 390, height: 844, mobile: true },
  { width: 414, height: 896, mobile: true },
  { width: 768, height: 1024, mobile: true },
  { width: 1024, height: 768, mobile: false },
  { width: 1440, height: 1000, mobile: false },
]

const browser = await chromium.launch({ headless: true })
const results = []
const failures = []

for (const viewport of WIDTHS) {
  const page = await browser.newPage({ viewport: { width: viewport.width, height: viewport.height } })
  await page.addInitScript(() => {
    class TestUtterance { constructor(text) { this.text = text; this.onend = null; this.onerror = null } }
    Object.defineProperty(window, 'SpeechSynthesisUtterance', { value: TestUtterance })
    Object.defineProperty(window, 'speechSynthesis', { value: { getVoices: () => [], cancel() {}, pause() {}, resume() {}, speak() {} } })
  })
  await page.goto(baseURL, { waitUntil: 'networkidle' })
  await page.getByRole('heading', { name: 'Choose a PDF to begin' }).waitFor()
  await page.locator('input[type=file]').setInputFiles(fixture)
  // The extraction label lives in the Document panel, hidden at mobile widths, so wait on
  // document text instead of a visible element.
  await page.waitForFunction(() => document.body.textContent?.includes('Ready to read'), undefined, { timeout: 20000 })

  const label = `${viewport.width}x${viewport.height}`
  const layout = await page.evaluate(() => {
    const doc = document.documentElement
    // Elements inside a deliberate inner scroller (the PDF preview pane) or a closed
    // details panel do not contribute to page-level overflow.
    const insideScroller = (el, axis) => {
      let node = el.parentElement
      while (node && node !== document.body) {
        const style = getComputedStyle(node)
        const value = axis === 'x' ? style.overflowX : style.overflowY
        if (value === 'auto' || value === 'scroll') return true
        node = node.parentElement
      }
      return false
    }
    const overflowing = []
    for (const el of document.querySelectorAll('body *')) {
      if (el.closest('details:not([open])')) continue
      const rect = el.getBoundingClientRect()
      if (rect.width === 0 && rect.height === 0) continue
      if (getComputedStyle(el).display === 'none') continue
      if (insideScroller(el, 'x')) continue
      if (rect.right > window.innerWidth + 1 || rect.left < -1) {
        overflowing.push(`${el.tagName.toLowerCase()}.${(el.className || '').toString().split(' ').filter(Boolean).slice(0, 2).join('.')}@${Math.round(rect.right)}`)
      }
    }
    const bar = document.querySelector('.mobile-bar')
    return {
      scrollWidth: doc.scrollWidth,
      viewportWidth: window.innerWidth,
      barPresent: Boolean(bar),
      barVisible: bar ? getComputedStyle(bar).display !== 'none' : false,
      transportVisible: Boolean(document.querySelector('.transport')) && getComputedStyle(document.querySelector('.transport')).display !== 'none',
      overflowing: overflowing.slice(0, 6),
    }
  })

  const measured = { ...viewport, label, ...layout }
  if (layout.scrollWidth > layout.viewportWidth) {
    failures.push(`${label}: horizontal overflow ${layout.scrollWidth} > ${layout.viewportWidth}`)
  }
  if (layout.overflowing.length) {
    failures.push(`${label}: elements past the viewport edge: ${layout.overflowing.join(', ')}`)
  }
  if (viewport.mobile) {
    if (!layout.barVisible) failures.push(`${label}: mobile bottom bar is not visible`)
  } else if (layout.barPresent || !layout.transportVisible) {
    failures.push(`${label}: desktop layout changed (bottom bar present or transport footer missing)`)
  }

  if (layout.barVisible) {
    // Scroll to the very bottom, then confirm no page content sits under the bar.
    const overlap = await page.evaluate(async () => {
      window.scrollTo(0, document.documentElement.scrollHeight)
      await new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve)))
      const bar = document.querySelector('.mobile-bar')
      const barRect = bar.getBoundingClientRect()
      // Content inside an inner vertical scroller (the preview pane) is clipped by that
      // scroller, so only the scroller's own box counts as page content.
      const insideScroller = (el) => {
        let node = el.parentElement
        while (node && node !== document.body) {
          const value = getComputedStyle(node).overflowY
          if (value === 'auto' || value === 'scroll') return true
          node = node.parentElement
        }
        return false
      }
      let maxContentBottom = 0
      let deepest = ''
      for (const el of document.querySelectorAll('.reader-deck *')) {
        if (bar.contains(el)) continue
        if (el.closest('details:not([open])')) continue
        if (insideScroller(el)) continue
        const rect = el.getBoundingClientRect()
        if (rect.width === 0 && rect.height === 0) continue
        if (getComputedStyle(el).display === 'none') continue
        if (rect.bottom > maxContentBottom) { maxContentBottom = rect.bottom; deepest = `${el.tagName.toLowerCase()}.${(el.className || '').toString().split(' ')[0]}` }
      }
      return {
        barTop: barRect.top,
        barBottom: barRect.bottom,
        barHeight: barRect.height,
        viewportHeight: window.innerHeight,
        maxContentBottom,
        deepest,
      }
    })
    measured.overlap = overlap
    if (overlap.barTop < 0 || overlap.barBottom > overlap.viewportHeight + 1) {
      failures.push(`${label}: bottom bar is outside the viewport (${Math.round(overlap.barTop)}..${Math.round(overlap.barBottom)})`)
    }
    // A pixel of rounding tolerance.
    if (overlap.maxContentBottom > overlap.barTop + 2) {
      failures.push(`${label}: content (${overlap.deepest}) is covered by the bar by ${Math.round(overlap.maxContentBottom - overlap.barTop)}px`)
    }
  }

  results.push(measured)
  await page.close()
}

await browser.close()
if (failures.length) {
  console.error(JSON.stringify({ status: 'failed', failures, results }, null, 2))
  process.exit(1)
}
console.log(JSON.stringify({ status: 'passed', widths: WIDTHS.map(v => v.width), results }, null, 2))
