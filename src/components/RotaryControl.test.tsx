import { cleanup, fireEvent, render, screen } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { RotaryControl, rotaryValue } from './RotaryControl'

afterEach(cleanup)

const props = { label: 'Speed', name: 'Reading speed', value: 1, min: 0.5, max: 2, step: 0.05, format: (value: number) => `${value.toFixed(2)}x` }

describe('RotaryControl', () => {
  it('quantizes and clamps without floating-point drift', () => {
    expect(rotaryValue(1.276, 0.5, 2, 0.05)).toBe(1.3)
    expect(rotaryValue(-3, 0.5, 2, 0.05)).toBe(0.5)
    expect(rotaryValue(9, 0.5, 2, 0.05)).toBe(2)
  })
  it('exposes native slider name, range, exact formatted value and instructions', () => {
    render(<RotaryControl {...props} onChange={vi.fn()} />)
    const slider = screen.getByRole('slider', { name: 'Reading speed' })
    expect(slider).toHaveAttribute('aria-valuetext', '1.00x')
    expect(slider).toHaveAttribute('step', '0.05')
    expect(slider).toHaveAccessibleDescription(/Drag up or down/)
  })
  it('commits numeric edits on blur and discards Escape, blank and invalid edits', () => {
    const change = vi.fn()
    render(<RotaryControl {...props} onChange={change} />)
    const input = screen.getByRole('spinbutton', { name: 'Speed multiplier' })
    fireEvent.change(input, { target: { value: '1.27' } })
    fireEvent.blur(input)
    expect(change).toHaveBeenLastCalledWith(1.25)
    change.mockClear()
    input.focus()
    fireEvent.change(input, { target: { value: '1.8' } })
    fireEvent.keyDown(input, { key: 'Escape' })
    expect(change).not.toHaveBeenCalled()
    fireEvent.change(input, { target: { value: '' } })
    fireEvent.blur(input)
    expect(change).not.toHaveBeenCalled()
  })
  it('keeps a non-step fitted percentage truthful', () => {
    render(<RotaryControl {...props} label="Zoom" name="Preview zoom" min={25} max={180} step={1} value={57} format={n => `${n}%`} onChange={vi.fn()} />)
    expect(screen.getByRole('slider', { name: 'Preview zoom' })).toHaveValue('57')
    expect(screen.getByRole('slider', { name: 'Preview zoom' })).toHaveAttribute('aria-valuetext', '57%')
  })
  it('cancels native range touch defaults and removes its listener on unmount', () => {
    const { unmount } = render(<RotaryControl {...props} onChange={vi.fn()} />)
    const slider = screen.getByRole('slider')
    const touch = new Event('touchstart', { cancelable: true, bubbles: true })
    slider.dispatchEvent(touch)
    expect(touch.defaultPrevented).toBe(true)
    unmount()
    const after = new Event('touchstart', { cancelable: true })
    slider.dispatchEvent(after)
    expect(after.defaultPrevented).toBe(false)
  })
  it('disables both keyboard and numeric paths', () => {
    render(<RotaryControl {...props} disabled onChange={vi.fn()} />)
    expect(screen.getByRole('slider')).toBeDisabled()
    expect(screen.getByRole('spinbutton')).toBeDisabled()
  })
})
