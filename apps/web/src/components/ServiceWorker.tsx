import { useEffect, useState } from 'react'
import { drainUploads } from '../lib/upload-queue'
import { onWorkerMessage } from '../lib/pwa'

/**
 * Registers the service worker (production builds only) and shows a calm prompt when a new version is waiting. The page never
 * reloads by itself: a reload mid-match would lose it, so the player chooses when.
 */
export function ServiceWorker() {
  const [waiting, setWaiting] = useState<ServiceWorker | null>(null)

  useEffect(() => {
    if (!('serviceWorker' in navigator)) return
    if (!import.meta.env.PROD) {
      // Dev and the e2e server never run a worker; remove one left by an earlier production visit to the same address.
      void navigator.serviceWorker.getRegistrations().then((all) => all.forEach((r) => void r.unregister())).catch(() => {})
      return
    }
    let reloading = false
    const onControllerChange = () => {
      if (reloading) window.location.reload()
    }
    const onMessage = (e: MessageEvent) => onWorkerMessage(e.data, (ev) => window.dispatchEvent(ev), () => void drainUploads().catch(() => {}))
    navigator.serviceWorker.addEventListener('controllerchange', onControllerChange)
    navigator.serviceWorker.addEventListener('message', onMessage)
    const watch = (reg: ServiceWorkerRegistration) => {
      // A worker that finished installing while an older one still controls the page is "waiting".
      const check = (w: ServiceWorker | null) => { if (w && navigator.serviceWorker.controller) setWaiting(w) }
      check(reg.waiting)
      reg.addEventListener('updatefound', () => {
        const installing = reg.installing
        installing?.addEventListener('statechange', () => { if (installing.state === 'installed') check(reg.waiting ?? installing) })
      })
    }
    void navigator.serviceWorker.register('/sw.js').then(watch).catch(() => {})
    ;(window as unknown as { __duelwiseReload?: () => void }).__duelwiseReload = () => { reloading = true }
    return () => {
      navigator.serviceWorker.removeEventListener('controllerchange', onControllerChange)
      navigator.serviceWorker.removeEventListener('message', onMessage)
    }
  }, [])

  if (!waiting) return null
  return (
    <div role="status" data-testid="update-prompt" className="fixed bottom-3 right-3 z-50 flex max-w-[calc(100vw-1.5rem)] items-center gap-3 rounded-control border border-line bg-surface px-4 py-3 text-sm shadow-lg">
      <span>New version available.</span>
      <button
        type="button"
        className="inline-flex min-h-11 items-center rounded-control bg-action px-4 font-semibold text-action-ink"
        onClick={() => {
          ;(window as unknown as { __duelwiseReload?: () => void }).__duelwiseReload?.()
          waiting.postMessage({ type: 'SKIP_WAITING' })
        }}
      >
        Reload
      </button>
    </div>
  )
}
