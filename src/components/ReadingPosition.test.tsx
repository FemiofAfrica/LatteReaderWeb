import { fireEvent, render, screen } from '@testing-library/react'
import { describe, expect, it, vi } from 'vitest'
import { ReadAlong } from './ReadAlong'
import { ReadingProgress } from './ReadingProgress'

describe('read-along and progress controls', () => {
  it('scrolls only its transcript while following and playing, preserves a paused mark', () => {
    const position = { offset: 10, evidence: 'boundary' as const, ranges: [{ pageNumber: 1, start: 6, end: 11 }] }
    const view = render(<ReadAlong text="First Fine." page={1} position={null} following status="playing" />)
    const scroller = view.container.querySelector('.read-along-text') as HTMLDivElement
    vi.spyOn(scroller, 'getBoundingClientRect').mockReturnValue({ top: 0, bottom: 100, height: 100 } as DOMRect)
    const original = HTMLElement.prototype.getBoundingClientRect
    HTMLElement.prototype.getBoundingClientRect = function () {
      if (this.tagName === 'MARK') return { top: 200, bottom: 220, height: 20 } as DOMRect
      return original.call(this)
    }
    view.rerender(<ReadAlong text="First Fine." page={1} position={position} following status="playing" />)
    expect(scroller.scrollTop).toBeGreaterThan(0)
    expect(view.container.querySelector('mark')?.textContent).toBe('Fine.')
    scroller.scrollTop = 0
    view.rerender(<ReadAlong text="First Fine." page={1} position={{ ...position }} following={false} status="playing" />)
    expect(scroller.scrollTop).toBe(0)
    view.rerender(<ReadAlong text="First Fine." page={1} position={{ ...position }} following status="paused" />)
    expect(scroller.scrollTop).toBe(0)
    expect(view.container.querySelector('mark')).toHaveAttribute('data-state', 'paused')
    view.rerender(<ReadAlong text="Other page." page={2} position={position} following={false} status="playing" />)
    expect(view.container.querySelector('mark')).toBeNull()
    HTMLElement.prototype.getBoundingClientRect = original
  })
  it('commits keyboard and pointer seeks only on release, with native range bounds', () => {
    const seek = vi.fn(), skip = vi.fn()
    render(<ReadingProgress value={10} max={100} disabled={false} onSeek={seek} onSkip={skip} />)
    const slider = screen.getByRole('slider', { name: 'Reading progress' })
    expect(slider).toHaveAttribute('min', '0'); expect(slider).toHaveAttribute('max', '100')
    fireEvent.change(slider, { target: { value: '50' } }); expect(seek).not.toHaveBeenCalled()
    fireEvent.pointerUp(slider); expect(seek).toHaveBeenLastCalledWith(50)
    fireEvent.change(slider, { target: { value: '51' } }); fireEvent.keyUp(slider, { key: 'ArrowRight' })
    expect(seek).toHaveBeenLastCalledWith(51)
    fireEvent.click(screen.getByRole('button', { name: 'Previous sentence' })); expect(skip).toHaveBeenLastCalledWith(-1)
    fireEvent.click(screen.getByRole('button', { name: 'Next sentence' })); expect(skip).toHaveBeenLastCalledWith(1)
  })
})
