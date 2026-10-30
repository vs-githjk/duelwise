import { useEffect } from 'react'
import { armVoiceOnFirstClick } from '../lib/speech'

/** Browsers block speech until the player has clicked something; this lets the first click anywhere turn the opponent's voice on. */
export function VoiceArm() {
  useEffect(() => {
    armVoiceOnFirstClick()
  }, [])
  return null
}
