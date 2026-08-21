import { describe, expect, it } from 'vitest'
import { detectResourceKind } from '../src/pages/resource-preview.js'

describe('detectResourceKind', () => {
  it('classifies common previewable files', () => {
    expect(detectResourceKind('photo.PNG')).toBe('image')
    expect(detectResourceKind('clip.webm')).toBe('video')
    expect(detectResourceKind('voice.wav')).toBe('audio')
    expect(detectResourceKind('spec.pdf')).toBe('pdf')
    expect(detectResourceKind('notes.md')).toBe('text')
    expect(detectResourceKind('data.json')).toBe('text')
    expect(detectResourceKind('pack.zip')).toBe('file')
  })
})
