import { useEffect } from 'react'
import { drainUploads } from '../lib/upload-queue'
import { isOffline, subscribeConnection } from '../lib/connection'

/** Retry persisted records even when the player does not open another game. */
export function UploadQueue() {
  useEffect(() => {
    const drain = () => { if (!isOffline()) void drainUploads().catch(() => {}) }
    drain()
    window.addEventListener('online', drain)
    // The chip's probe notices the server coming back even when the browser never fires `online`.
    const unsubscribe = subscribeConnection(drain)
    const timer = window.setInterval(drain, 30_000)
    return () => { window.removeEventListener('online', drain); unsubscribe(); window.clearInterval(timer) }
  }, [])
  return null
}
