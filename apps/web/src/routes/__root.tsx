/// <reference types="vite/client" />
import { useEffect, type ReactNode } from 'react'
import { HeadContent, Link, Outlet, Scripts, createRootRoute } from '@tanstack/react-router'
import { PRODUCT } from '@duelwise/core/src/product'
import appCss from '../styles/app.css?url'
import { ErrorBoundary, looksOffline } from '../components/ErrorBoundary'
import { NotFound } from '../components/NotFound'
import { UploadQueue } from '../components/UploadQueue'
import { OfflineChip } from '../components/OfflineChip'
import { ServiceWorker } from '../components/ServiceWorker'
import { UpdateNotice } from '../components/UpdateNotice'
import { UserMenu } from '../components/UserMenu'
import { VoiceArm } from '../components/VoiceArm'
import { shareMeta } from '../lib/site-meta'
import { installStaleChunkGuard } from '../lib/stale-chunk'
import { CSS_GUARD_SCRIPT } from '../lib/css-guard'
import { getViewer } from '../server/profile-fns'

/** The last signed-in answer this browser tab got, so a page change with no connection keeps the header as it was. Browser only. */
let lastViewer: Awaited<ReturnType<typeof getViewer>> | undefined

export const Route = createRootRoute({
  loader: async () => {
    try {
      const viewer = await getViewer()
      if (typeof window !== 'undefined') lastViewer = viewer
      return viewer
    } catch (error) {
      if (typeof window !== 'undefined' && looksOffline(error)) return lastViewer ?? { user: null, owner: false }
      throw error
    }
  },
  head: () => ({
    meta: [{ charSet: 'utf-8' }, { name: 'viewport', content: 'width=device-width, initial-scale=1, viewport-fit=cover' }, { title: PRODUCT.name }, { name: 'theme-color', content: '#2b6fe6' }, { name: 'apple-mobile-web-app-capable', content: 'yes' }, { name: 'apple-mobile-web-app-status-bar-style', content: 'default' }, { name: 'apple-mobile-web-app-title', content: 'Duelwise' }, ...shareMeta()],
    links: [
      { rel: 'stylesheet', href: appCss },
      { rel: 'manifest', href: '/manifest.webmanifest' },
      { rel: 'apple-touch-icon', href: '/icons/apple-touch-icon.png' },
      { rel: 'icon', href: '/favicon.ico', sizes: 'any' },
      { rel: 'icon', type: 'image/png', sizes: '32x32', href: '/icons/favicon-32.png' },
      // The two faces every page paints first; Geist Mono and the rest load when something uses them.
      { rel: 'preload', href: '/fonts/geist-latin.woff2', as: 'font', type: 'font/woff2', crossOrigin: 'anonymous' },
      { rel: 'preload', href: '/fonts/fraunces-latin.woff2', as: 'font', type: 'font/woff2', crossOrigin: 'anonymous' },
    ],
    // Production only: the dev server injects styles from script, so the check would misfire there.
    scripts: import.meta.env.PROD ? [{ children: CSS_GUARD_SCRIPT }] : [],
  }),
  shellComponent: RootDocument,
  component: RootPage,
  notFoundComponent: NotFound,
})

function RootPage() {
  // After a new deploy an open tab can ask for a script that is gone; one fresh load fixes it (guarded, see lib/stale-chunk.ts).
  useEffect(() => installStaleChunkGuard(), [])
  return (
    <ErrorBoundary>
      <UploadQueue />
      <ServiceWorker />
      <UpdateNotice />
      <OfflineChip />
      <VoiceArm />
      <Outlet />
    </ErrorBoundary>
  )
}

function RootDocument({ children }: { children: ReactNode }) {
  return (
    <html lang="en">
      <head>
        <HeadContent />
      </head>
      <body>
        <a href="#main" className="sr-only focus:not-sr-only focus:fixed focus:left-4 focus:top-2 focus:z-50 focus:inline-flex focus:min-h-11 focus:items-center focus:rounded-control focus:bg-action focus:px-4 focus:font-semibold focus:text-action-ink" data-testid="skip-link">
          Skip to content
        </a>
        <div className="flex min-h-dvh flex-col bg-canvas text-ink">
          <header className="border-b border-line">
            <div className="group/head mx-auto flex min-h-16 max-w-content flex-wrap items-center gap-x-2 px-4 py-1 sm:flex-nowrap sm:gap-6 md:px-10">
              <Link to="/" className="inline-flex min-h-11 items-center gap-2 font-display text-base sm:text-display-sm" aria-label={`${PRODUCT.name} home`} data-testid="home-link">
                <img src="/icons/logo-mark.svg" alt="" width={30} height={30} className="size-[30px] shrink-0" data-testid="header-logo" />
                {PRODUCT.name}
              </Link>
              <nav className="order-last flex w-full items-center justify-between gap-1 text-sm font-medium sm:order-none sm:w-auto sm:justify-start sm:text-base" aria-label="Sections">
                <Link to="/play" className="inline-flex min-h-11 min-w-11 items-center justify-center px-0.5 text-muted hover:text-ink sm:px-3" activeProps={{ className: 'text-ink' }}>
                  Games
                </Link>
                <Link to="/leaderboard/$game" params={{ game: PRODUCT.games.chess.slug }} className="inline-flex min-h-11 min-w-11 items-center justify-center px-0.5 text-muted hover:text-ink sm:px-3" data-testid="nav-leaderboard" activeProps={{ className: 'text-ink' }}>
                  Leaderboard
                </Link>
                <Link to="/ai" className="inline-flex min-h-11 min-w-11 items-center justify-center whitespace-nowrap px-0.5 text-muted hover:text-ink sm:px-3" data-testid="nav-ai" activeProps={{ className: 'text-ink' }}>
                  The AI
                </Link>
                <Link to="/settings" className="inline-flex min-h-11 min-w-11 items-center justify-center px-0.5 text-muted hover:text-ink sm:px-3" data-testid="nav-settings" activeProps={{ className: 'text-ink' }}>
                  Settings
                </Link>
              </nav>
              <ErrorBoundary fallback={() => null}>
                <UserMenu />
              </ErrorBoundary>
            </div>
          </header>
          <main id="main" tabIndex={-1} className="mx-auto w-full max-w-content flex-1 px-4 pb-16 outline-none md:px-10">{children}</main>
          <footer className="border-t border-line">
            <nav className="mx-auto flex max-w-content flex-wrap gap-x-2 px-4 py-4 text-sm text-muted md:px-10" aria-label="Site">
              {[
                { to: '/ai', label: 'The AI' },
                { to: '/settings', label: 'Settings' },
                { to: '/terms', label: 'Terms' },
                { to: '/privacy', label: 'Privacy' },
              ].map((l) => (
                <Link key={l.to} to={l.to} className="inline-flex min-h-11 items-center px-2 hover:text-ink">
                  {l.label}
                </Link>
              ))}
            </nav>
          </footer>
        </div>
        <Scripts />
      </body>
    </html>
  )
}
