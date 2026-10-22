import { cleanup, fireEvent, render, screen } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { AudioReadyBar } from './AudioReadyBar'
import { audioReadyProgress } from '../speech/audioReady'

afterEach(cleanup)

describe('AudioReadyBar', () => {
  it('shows generated extent, percent and the minimize line', () => {
    const progress = audioReadyProgress({
      parts: [{ duration: 120, pageEnd: 8 }],
      totalParts: 4,
      listenedSeconds: 30,
    })
    render(<AudioReadyBar progress={progress} canPrepare onPrepare={vi.fn()} />)
    expect(screen.getByText('25% ready')).toBeInTheDocument()
    expect(screen.getByText(/About 2 min ready/)).toBeInTheDocument()
    expect(screen.getByText(/play until page 8/)).toBeInTheDocument()
    expect(screen.getByRole('button', { name: 'Prepare whole document' })).toBeEnabled()
  })

  it('lets the reader cancel a whole-document prepare', () => {
    const cancel = vi.fn()
    const progress = audioReadyProgress({ parts: [{ duration: 10, pageEnd: 2 }], totalParts: 8, listenedSeconds: 0, preparing: true })
    render(<AudioReadyBar progress={progress} onCancel={cancel} />)
    fireEvent.click(screen.getByRole('button', { name: 'Cancel preparing' }))
    expect(cancel).toHaveBeenCalledOnce()
  })
})
