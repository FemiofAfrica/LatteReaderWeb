import { cleanup, fireEvent, render, screen } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { PageTurnViewer } from './PageTurnViewer'
afterEach(cleanup)
const setup = (allowSwipe = true) => {
  const navigate = vi.fn()
  render(<PageTurnViewer page={2} pageCount={3} allowSwipe={allowSwipe} onNavigate={navigate}><div className="preview-scroll"><canvas data-testid="page" /><p data-testid="transcript">Selectable transcript</p></div></PageTurnViewer>)
  return { navigate, canvas: screen.getByTestId('page') }
}
const touch = (x: number, y: number) => ({ identifier: 1, clientX: x, clientY: y })
const gesture = (target: HTMLElement, from: [number, number], to: [number, number], cancel = false) => {
  fireEvent.touchStart(target, { touches: [touch(...from)] })
  fireEvent.touchMove(target, { touches: [touch(...to)] })
  fireEvent[ cancel ? 'touchCancel' : 'touchEnd' ](target, { touches: [], changedTouches: [touch(...to)] })
}
describe('PageTurnViewer', () => {
  it('adds no second permanent navigation strip', () => {
    setup()
    expect(screen.queryByRole('button')).toBeNull()
  })
  it('uses the existing navigation callback for left and right swipes', () => {
    const { canvas, navigate } = setup()
    gesture(canvas, [220, 300], [120, 300])
    expect(navigate).toHaveBeenLastCalledWith(3)
    gesture(canvas, [120, 300], [220, 300])
    expect(navigate).toHaveBeenLastCalledWith(1)
  })
  it('ignores vertical, short, edge-back, cancelled and transcript gestures', () => {
    const { canvas, navigate } = setup()
    gesture(canvas, [220, 300], [200, 400])
    gesture(canvas, [220, 300], [180, 300])
    gesture(canvas, [10, 300], [130, 300])
    gesture(canvas, [220, 300], [120, 300], true)
    gesture(screen.getByTestId('transcript'), [220, 300], [120, 300])
    expect(navigate).not.toHaveBeenCalled()
  })
  it('does not turn a manually enlarged page even without horizontal overflow', () => {
    const { canvas, navigate } = setup(false)
    gesture(canvas, [220, 300], [120, 300])
    expect(navigate).not.toHaveBeenCalled()
  })
  it('locks vertical scrolling and rejects multi-touch', () => {
    const { canvas, navigate } = setup()
    fireEvent.touchStart(canvas, { touches: [touch(220, 300)] })
    fireEvent.touchMove(canvas, { touches: [touch(220, 330)] })
    fireEvent.touchMove(canvas, { touches: [touch(120, 330)] })
    fireEvent.touchEnd(canvas, { touches: [], changedTouches: [touch(120, 330)] })
    fireEvent.touchStart(canvas, { touches: [touch(220, 300), {...touch(120,300),identifier:2}] })
    fireEvent.touchMove(canvas, { touches: [touch(120, 300)] })
    fireEvent.touchEnd(canvas, { touches: [], changedTouches: [touch(120, 300)] })
    expect(navigate).not.toHaveBeenCalled()
  })
})
