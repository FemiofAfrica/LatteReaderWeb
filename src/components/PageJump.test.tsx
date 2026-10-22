import { cleanup, fireEvent, render, screen } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { PageJump, parsePageJump } from './PageJump'

afterEach(cleanup)

describe('parsePageJump', () => {
  it('rejects empty and partial non-numeric values and clamps a finished number', () => {
    expect(parsePageJump('', 40)).toBeNull()
    expect(parsePageJump('  ', 40)).toBeNull()
    expect(parsePageJump('12a', 40)).toBeNull()
    expect(parsePageJump('205', 40)).toBe(40)
    expect(parsePageJump('8', 40)).toBe(8)
    expect(parsePageJump('0', 40)).toBe(1)
  })
})

describe('PageJump', () => {
  it('lets the field go empty and hold a partial page number until Enter, blur or Go', () => {
    const navigate = vi.fn()
    render(<PageJump page={1} pageCount={400} onNavigate={navigate} showGoButton />)
    const input = screen.getByLabelText('Go to page')
    expect(input).toHaveAttribute('inputMode', 'numeric')
    fireEvent.change(input, { target: { value: '' } })
    expect(input).toHaveValue('')
    expect(navigate).not.toHaveBeenCalled()
    fireEvent.change(input, { target: { value: '2' } })
    expect(input).toHaveValue('2')
    expect(navigate).not.toHaveBeenCalled()
    fireEvent.change(input, { target: { value: '205' } })
    expect(navigate).not.toHaveBeenCalled()
    fireEvent.keyDown(input, { key: 'Enter' })
    expect(navigate).toHaveBeenCalledWith(205)
  })

  it('commits on blur and Go, and restores the current page if the draft is empty', () => {
    const navigate = vi.fn()
    render(<PageJump page={4} pageCount={20} onNavigate={navigate} showGoButton />)
    const input = screen.getByLabelText('Go to page')
    fireEvent.change(input, { target: { value: '' } })
    fireEvent.blur(input)
    expect(navigate).not.toHaveBeenCalled()
    expect(input).toHaveValue('4')
    fireEvent.change(input, { target: { value: '9' } })
    fireEvent.click(screen.getByRole('button', { name: 'Go' }))
    expect(navigate).toHaveBeenCalledWith(9)
  })
})
