import { beforeEach, describe, expect, test } from 'bun:test'
import { resetAudioForTests, setMuted, setVolume } from '../../../lib/audio'
import { Audio3D } from './audio3d'

describe('Audio3D defaults follow the site-wide audio prefs', () => {
  beforeEach(() => {
    resetAudioForTests()
  })

  test('a muted site starts muted and follows later changes', () => {
    setMuted(true)
    setVolume(0.3)
    const a = new Audio3D() as unknown as { volume: number; muted: boolean; dispose(): void }
    expect(a.muted).toBe(true)
    expect(a.volume).toBeCloseTo(0.3, 9)
    setMuted(false)
    setVolume(0.8)
    expect(a.muted).toBe(false)
    expect(a.volume).toBeCloseTo(0.8, 9)
    a.dispose()
    setVolume(0.1)
    expect(a.volume).toBeCloseTo(0.8, 9)
  })
})
