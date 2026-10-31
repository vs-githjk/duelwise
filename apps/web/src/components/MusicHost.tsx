import { useEffect } from 'react'
import { startMusic } from '../lib/music'

/** Listens for the first tap, a hidden tab and the switches, so a match's music (see GameShell) can start. Renders nothing. */
export function MusicHost() {
  useEffect(() => startMusic(), [])
  return null
}
