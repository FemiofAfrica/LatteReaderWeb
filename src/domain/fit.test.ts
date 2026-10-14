import { describe, expect, it } from 'vitest'
import { computeFitZoom, MAX_PREVIEW_ZOOM, MIN_PREVIEW_ZOOM } from './fit'

// The fixture page is US Letter: 612x792 points, so 612 CSS pixels at 100% zoom.
const PAGE_WIDTH = 612

describe('computeFitZoom', () => {
  it('fits a 612px page into the phone preview content width', () => {
    // 390px viewport: 390 client width minus the preview scroller's 18px padding each side.
    expect(computeFitZoom(354, PAGE_WIDTH)).toBe(57)
    expect(computeFitZoom(284, PAGE_WIDTH)).toBe(46) // 320px viewport must fit below 50%.
    // 360px and 414px viewports.
    expect(computeFitZoom(324, PAGE_WIDTH)).toBe(52)
    expect(computeFitZoom(378, PAGE_WIDTH)).toBe(61)
  })

  it('leaves a page at its natural size when the container matches it', () => {
    expect(computeFitZoom(612, PAGE_WIDTH)).toBe(100)
  })

  it('scales a page up on a container wider than the page', () => {
    // 768px viewport: 768 minus 36px padding.
    expect(computeFitZoom(732, PAGE_WIDTH)).toBe(119)
  })

  it('never lets rounding push the page past the container', () => {
    for (const width of [324, 354, 378, 512, 611, 732, 900]) {
      const zoom = computeFitZoom(width, PAGE_WIDTH)
      expect(Math.floor(PAGE_WIDTH * (zoom / 100))).toBeLessThanOrEqual(width)
    }
  })

  it('clamps to the zoom control range', () => {
    expect(computeFitZoom(10, PAGE_WIDTH)).toBe(MIN_PREVIEW_ZOOM)
    expect(computeFitZoom(100_000, PAGE_WIDTH)).toBe(MAX_PREVIEW_ZOOM)
  })

  it('falls back to the minimum on unusable measurements', () => {
    expect(computeFitZoom(0, PAGE_WIDTH)).toBe(MIN_PREVIEW_ZOOM)
    expect(computeFitZoom(-40, PAGE_WIDTH)).toBe(MIN_PREVIEW_ZOOM)
    expect(computeFitZoom(354, 0)).toBe(MIN_PREVIEW_ZOOM)
    expect(computeFitZoom(Number.NaN, PAGE_WIDTH)).toBe(MIN_PREVIEW_ZOOM)
    expect(computeFitZoom(354, Number.POSITIVE_INFINITY)).toBe(MIN_PREVIEW_ZOOM)
  })
})
