// Fit-to-width zoom for the mobile preview.
//
// The reader must be able to read a full line without scrolling sideways, so the initial
// mobile view renders the page at the width the preview container actually offers rather
// than at a fixed 100%. Shared by the app and its regression test.

export const MIN_PREVIEW_ZOOM = 50
export const MAX_PREVIEW_ZOOM = 180

/**
 * Percentage zoom that renders a page of `pageWidth` CSS pixels into `availableWidth`
 * pixels without horizontal scrolling.
 *
 * Floored to a whole percent so rounding can never push the page past the container, then
 * clamped to the zoom control's range. Unusable measurements fall back to the minimum.
 */
export function computeFitZoom(availableWidth: number, pageWidth: number): number {
  if (!Number.isFinite(availableWidth) || !Number.isFinite(pageWidth) || availableWidth <= 0 || pageWidth <= 0) {
    return MIN_PREVIEW_ZOOM
  }
  const percent = Math.floor((availableWidth / pageWidth) * 100)
  return Math.min(MAX_PREVIEW_ZOOM, Math.max(MIN_PREVIEW_ZOOM, percent))
}
