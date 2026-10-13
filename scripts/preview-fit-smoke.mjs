// Mobile preview fit-to-width smoke.
//
// At every phone and small-tablet width the preview must open at a zoom computed from the
// preview container and the page's native width, so a whole line is readable without
// sideways scrolling. The readout must state the percentage actually rendered. A zoom the
// reader sets by hand must stick (including across rotation and panel switches) and must not
// be silently re-fitted; the explicit "Fit width" control returns to the fit. Desktop is
// unchanged and still opens at 100%.
import { chromium } from 'playwright'
import { fileURLToPath } from 'node:url'
import path from 'node:path'

const root = path.dirname(path.dirname(fileURLToPath(import.meta.url)))
const fixture = path.join(root, 'tests/fixtures/latte-reader-text-fixture.pdf')
const baseURL = process.env.LATTE_READER_URL ?? 'http://127.0.0.1:4176/'
// The fixture page is US Letter, so 612 CSS pixels wide at 100% zoom.
const PAGE_WIDTH = 612
const MOBILE = [
  { width: 360, height: 844 },
  { width: 390, height: 844 },
  { width: 414, height: 896 },
  { width: 768, height: 1024 },
]

const browser = await chromium.launch({ headless: true })
const failures = []
const check = (condition, message) => { if (!condition) failures.push(message) }

const openFixture = async (page, file = fixture) => {
  await page.goto(baseURL, { waitUntil: 'networkidle' })
  await page.getByRole('heading', { name: 'Choose a PDF to begin' }).waitFor()
  await page.locator('input[type=file]').setInputFiles(file)
  await page.waitForFunction(() => document.body.textContent?.includes('Extraction complete'), undefined, { timeout: 20000 })
  await page.locator('.page-stage canvas').waitFor({ timeout: 20000 })
  await page.waitForTimeout(350)
}

const measure = (page) => page.evaluate(() => {
  const scroller = document.querySelector('.preview-scroll')
  const canvas = document.querySelector('.page-stage canvas')
  const style = getComputedStyle(scroller)
  const readout = document.querySelector('.preview-zoom output') ?? document.querySelector('.zoom-readout')
  return {
    viewport: window.innerWidth,
    scrollerClientWidth: scroller.clientWidth,
    contentWidth: scroller.clientWidth - parseFloat(style.paddingLeft) - parseFloat(style.paddingRight),
    scrollerScrollWidth: scroller.scrollWidth,
    canvasWidth: Math.round(canvas.getBoundingClientRect().width),
    canvasAttrWidth: canvas.width,
    needsHorizontalScroll: scroller.scrollWidth > scroller.clientWidth,
    zoomReadout: (readout?.textContent ?? '').replace(/\s+/g, ' ').trim(),
  }
})

const shownPercent = (m) => Number((m.zoomReadout.match(/\d+/) ?? [])[0])

const fitted = []
for (const viewport of MOBILE) {
  const page = await browser.newPage({ viewport })
  await openFixture(page)
  const m = await measure(page)
  const percent = shownPercent(m)
  const expected = Math.floor((m.contentWidth / PAGE_WIDTH) * 100)
  fitted.push({ ...viewport, ...m, shownPercent: percent })

  check(!m.needsHorizontalScroll, `${viewport.width}x${viewport.height}: preview still scrolls sideways (${m.scrollerScrollWidth} > ${m.scrollerClientWidth})`)
  check(m.canvasWidth <= m.contentWidth, `${viewport.width}x${viewport.height}: page (${m.canvasWidth}px) is wider than the container content (${m.contentWidth}px)`)
  check(percent === expected, `${viewport.width}x${viewport.height}: readout ${m.zoomReadout} does not match the fitted value ${expected}%`)
  // Truthful readout: the drawn page must match the percentage shown to within a pixel.
  check(Math.abs(m.canvasWidth - Math.floor(PAGE_WIDTH * (percent / 100))) <= 1, `${viewport.width}x${viewport.height}: readout ${m.zoomReadout} does not match the drawn width ${m.canvasWidth}px`)
  check(!(percent === 100 && viewport.width < 700), `${viewport.width}x${viewport.height}: still opened at a flat 100% instead of a fitted value`)
  await page.close()
}

// A zoom set by hand sticks and is never silently re-fitted.
const manualPage = await browser.newPage({ viewport: { width: 390, height: 844 } })
await openFixture(manualPage)
const beforeManual = await measure(manualPage)
await manualPage.getByLabel('Preview zoom').fill('150')
await manualPage.waitForTimeout(300)
const afterManual = await measure(manualPage)
check(shownPercent(afterManual) === 150, `A manual zoom of 150% read back as ${afterManual.zoomReadout}`)
check(afterManual.canvasWidth === Math.floor(PAGE_WIDTH * 1.5), `A manual 150% drew ${afterManual.canvasWidth}px instead of ${Math.floor(PAGE_WIDTH * 1.5)}px`)

await manualPage.setViewportSize({ width: 360, height: 844 })
await manualPage.waitForTimeout(400)
const afterResize = await measure(manualPage)
check(shownPercent(afterResize) === 150, `Resizing re-fitted the manual zoom to ${afterResize.zoomReadout}`)

await manualPage.getByRole('tab', { name: 'Document' }).click()
await manualPage.getByRole('tab', { name: 'Preview' }).click()
await manualPage.waitForTimeout(400)
const afterPanelSwitch = await measure(manualPage)
check(shownPercent(afterPanelSwitch) === 150, `Switching to the Preview panel re-fitted the manual zoom to ${afterPanelSwitch.zoomReadout}`)

await manualPage.getByRole('button', { name: 'Fit width' }).click()
await manualPage.waitForTimeout(400)
const afterFitButton = await measure(manualPage)
check(!afterFitButton.needsHorizontalScroll, 'Fit width left the preview needing sideways scrolling')
check(shownPercent(afterFitButton) !== 150, 'Fit width did not return to the fitted zoom')
await manualPage.close()

// Desktop is unchanged: it opens at 100%.
const desktopPage = await browser.newPage({ viewport: { width: 1440, height: 1000 } })
await openFixture(desktopPage)
const desktop = await measure(desktopPage)
check(desktop.zoomReadout.includes('100%'), `Desktop opened at ${desktop.zoomReadout} instead of 100%`)
check(desktop.canvasWidth === PAGE_WIDTH, `Desktop drew ${desktop.canvasWidth}px instead of ${PAGE_WIDTH}px`)
check(await desktopPage.locator('.fit-width-button').count() === 0, 'The mobile Fit width control is present on desktop')
await desktopPage.close()

await browser.close()
const report = {
  status: failures.length ? 'failed' : 'passed',
  fitted,
  manual: { fittedBefore: beforeManual.zoomReadout, afterManual: afterManual.zoomReadout, afterResize: afterResize.zoomReadout, afterPanelSwitch: afterPanelSwitch.zoomReadout, afterFitButton: afterFitButton.zoomReadout },
  desktop: { zoomReadout: desktop.zoomReadout, canvasWidth: desktop.canvasWidth },
}
if (failures.length) {
  console.error(JSON.stringify({ ...report, failures }, null, 2))
  process.exit(1)
}
console.log(JSON.stringify(report, null, 2))
