import { createServerFn } from '@tanstack/react-start'
import { getRequestHeader, getRequestUrl, setResponseStatus } from '@tanstack/react-start/server'
import { getSessionUser } from './caller'
import { existingGuestId } from './guest'
import { getReport, setReportSettings, type ReportView, type Viewer } from './report'
import { loadChessEvaluator } from './report-eval'
import { getServerDb } from './server-db'
import { gameRecordsTrainable } from './stats-fns'

/** Who is looking, without ever creating a guest cookie: a report view must not mint players. */
async function viewerFromRequest(): Promise<Viewer> {
  const user = await getSessionUser()
  const { db } = await getServerDb()
  return { userId: user?.id, guestId: await existingGuestId(db, getRequestHeader('cookie')) }
}

export interface ReportPage {
  view: ReportView
  /** Where this site is served from, for the absolute links in the share meta tags. */
  origin: string
}

/** The report for a match id, or null (the route turns that into the not-found page). */
export const getReportPage = createServerFn({ method: 'GET' })
  .validator((d: unknown) => ({ id: typeof (d as { id?: unknown })?.id === 'string' ? (d as { id: string }).id : '' }))
  .handler(async ({ data }): Promise<ReportPage | null> => {
    const { db } = await getServerDb()
    const origin = process.env.BETTER_AUTH_URL?.replace(/\/$/, '') || getRequestUrl().origin
    const view = await getReport(db, data.id, await viewerFromRequest(), {
      chessEvaluator: () => loadChessEvaluator({ origin }),
      recordsTrainable: gameRecordsTrainable,
    })
    if (!view) {
      setResponseStatus(404)
      return null
    }
    // A private report answers as an unknown address would for anyone but the player; it still renders its own state page.
    return { view, origin }
  })

/** The player turns the public link off or on, or the name on the page. */
export const saveReportSettings = createServerFn({ method: 'POST' })
  .validator((d: unknown) => (typeof d === 'object' && d !== null ? (d as Record<string, unknown>) : {}))
  .handler(async ({ data }): Promise<boolean> => {
    const { db } = await getServerDb()
    const ok = await setReportSettings(db, typeof data.id === 'string' ? data.id : '', await viewerFromRequest(), { linkPublic: data.linkPublic, showName: data.showName })
    if (!ok) setResponseStatus(403)
    return ok
  })
