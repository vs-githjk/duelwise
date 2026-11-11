import { useEffect, useState, type ReactNode } from 'react'
import { Link, useRouter } from '@tanstack/react-router'
import { PRODUCT, type GameId } from '@duelwise/core/src/product'
import { cn } from '../lib/cn'
import { LEVEL_LABEL } from '../lib/level-info'
import { Avatar } from '../personas/Avatar'
import { bioFor, personaFor, styleLine } from '../personas'
import { RECORD_WINDOW, type ReportView } from '../server/report'
import type { ReportPage as Page } from '../server/report-fns'
import { saveReportSettings } from '../server/report-fns'
import { matchesWindow, provisionalNote } from '../lib/copy'
import { reportLearnsCard } from '../lib/honest-copy'
import { registryFor } from '../lib/registries'
import { verifiedStrength } from '../lib/strength-gates'
import { emptyReviewText, hasGameView, hasKeyMoments, headline, learningCopy, recordLine, reportTiles, shareControlsNote } from './copy'
import { EvalChart } from './EvalChart'
import { NearMissStrip } from '../components/NearMiss'
import { showsNearMiss } from './near-miss'
import { CARD_HEIGHT, CARD_WIDTH } from './share-card'
import type { Moment } from './types'
import { FourBoard } from './FourBoard'
import { SlackBoard } from './SlackBoard'
import { PenaltyMap } from './PenaltyMap'
import { WordGrid } from './WordGrid'
import { pollWritingReport } from './writing-poll'

const control = 'inline-flex min-h-11 items-center rounded-control border border-line bg-surface px-4 font-semibold text-ink'
const primary = 'inline-flex min-h-11 items-center rounded-control bg-action px-5 font-semibold text-action-ink'

function Card({ title, note, children, testId, className }: { title: string; note?: string; children: ReactNode; testId?: string; className?: string }) {
  return (
    <section className={cn('grid min-w-0 content-start gap-3 rounded-card border border-line bg-surface p-4 shadow-card md:p-5', className)} data-testid={testId}>
      <header className="flex flex-wrap items-baseline justify-between gap-x-4 gap-y-1">
        <h2 className="font-display text-display-sm">{title}</h2>
        {note ? <p className="text-sm text-muted">{note}</p> : null}
      </header>
      {children}
    </section>
  )
}

const TONE: Record<Moment['kind'], string> = { best: 'text-good-ink', worst: 'text-bad-ink', turning: 'text-ink', end: 'text-ink', info: 'text-ink' }

function Moments({ moments }: { moments: Moment[] }) {
  return (
    <ol className="grid divide-y divide-line" data-testid="moments">
      {moments.map((m, i) => (
        <li key={i} className="grid grid-cols-[minmax(0,1fr)_auto] gap-x-4 gap-y-1 py-3 first:pt-0 last:pb-0 sm:grid-cols-[9rem_minmax(0,1fr)_auto]" data-kind={m.kind}>
          <div className="col-span-2 sm:col-span-1">
            <p className={cn('font-mono text-base font-semibold', TONE[m.kind])}>{m.label}</p>
            <p className="font-mono text-xs text-muted">{m.tag}</p>
          </div>
          <p className="min-w-0 text-base">{m.text}</p>
          {m.value ? (
            <p className="text-right font-mono text-base tabular">
              {m.value}
              <span className="block text-xs text-muted">{m.valueLabel}</span>
            </p>
          ) : null}
        </li>
      ))}
    </ol>
  )
}

function Tile({ value, label, sub }: { value: string; label: string; sub?: string }) {
  return (
    <div className="rounded-card bg-surface-2 p-4">
      <p className="font-display text-display-sm tabular">{value}</p>
      <p className="text-sm text-muted">{label}</p>
      {sub ? <p className="text-sm text-muted">{sub}</p> : null}
    </div>
  )
}

/** The report for one match. The owner sees their rating, training status and sharing controls; everyone else sees the public view. */
export function ReportPageView({ page }: { page: Page }) {
  const { view, origin } = page
  const router = useRouter()
  useEffect(() => {
    if (view.status !== 'writing') return
    return pollWritingReport(() => { void router.invalidate() })
  }, [router, view.status])
  const persona = personaFor(view.level)
  const cfg = PRODUCT.games[view.game]
  if (view.status === 'private') return <StateBlock testId="report-private" title="This report is private" text="The player turned this link off. Only they can open it." />
  if (view.status === 'writing') return <StateBlock testId="report-writing" title={view.mode === 'public' ? 'Writing the report' : 'Writing your report'} text="Rating pending. The report appears when the match finishes." />
  if (view.status === 'rejected') {
    return <StateBlock testId="report-rejected" title="No report for this match" text="The record of this match did not replay to the same result, so it was not counted and there is nothing to report." />
  }
  const body = view.body!
  const owner = view.owner
  const link = `${origin}/report/${view.id}`
  const title = headline(view, body.outcome)
  const stats = reportTiles(view, body)
  const delta = owner?.rating ? owner.rating.after - owner.rating.before : null
  return (
    <article className="grid gap-6 py-8" data-testid="report" data-mode={view.mode} data-status={view.status} data-outcome={body.outcome}>
      <header className="grid gap-3 border-b border-line pb-6">
        <p className="text-sm text-muted">{view.mode === 'owner' ? 'Match report' : 'Shared match'}</p>
        <h1 className="font-display text-display-lg" data-testid="report-title">{title}</h1>
        <p className="flex flex-wrap items-center gap-x-3 gap-y-2 text-base">
          <Avatar level={view.level} size={36} decorative />
          <span className="font-semibold">{persona.name}</span>
          <span className="text-muted">{LEVEL_LABEL[view.level]}</span>
        </p>
        <p className="flex flex-wrap gap-x-4 gap-y-1 text-sm text-muted" data-testid="report-meta">
          <span>{cfg.displayName}</span>
          {view.day ? <span>{view.day}</span> : null}
          <span>{body.reason}</span>
          {view.seed != null ? <span>Seed {view.seed}</span> : null}
        </p>
        <div className="flex flex-wrap gap-2">
          <Link to="/play/$game" params={{ game: cfg.slug }} className={primary} data-testid="report-play">
            {view.mode === 'owner' ? 'Play again' : `Play ${persona.name} yourself`}
          </Link>
        </div>
      </header>

      {body.reaction ? (
        <blockquote className="grid gap-1 rounded-card border border-line bg-surface p-4" data-testid="report-reaction">
          <p className="text-base">{`“${body.reaction}”`}</p>
          <footer className="text-sm text-muted">{persona.name}</footer>
        </blockquote>
      ) : null}

      <div className="grid gap-6 lg:grid-cols-[minmax(0,2fr)_minmax(0,1fr)]">
        <div className="grid min-w-0 content-start gap-6">
          {view.game === 'arena' ? <Card title="Your opponent" testId="report-arena-opponent"><div className="flex items-center gap-3"><Avatar level={view.level} size={56} decorative /><p><strong>{persona.name}, {LEVEL_LABEL[view.level]}</strong><br /><span className="text-muted">{body.reason}</span></p></div></Card> : null}
          {showsNearMiss(body.nearMiss) ? <NearMissStrip nearMiss={body.nearMiss} outcome={body.outcome} testId="report-near-miss" /> : null}
          <div className="grid grid-cols-3 gap-3 md:grid-cols-4" data-testid="report-tiles">
            {stats.map((s) => (
              <Tile key={s.label} {...s} />
            ))}
          </div>
          {body.series ? (
            <Card title="How the game went" testId="report-chart">
              <EvalChart series={body.series} viewer={view.mode} />
            </Card>
          ) : null}
          {body.wordRows ? (
            <Card title="Guess by guess" testId="report-words">
              <WordGrid rows={body.wordRows} viewer={view.mode} opponent={persona.name} />
            </Card>
          ) : null}
          {body.fourView ? (
            <Card title="Final board and drops" testId="report-four">
              <FourBoard view={body.fourView} viewer={view.mode} opponent={persona.name} />
            </Card>
          ) : null}
          {body.slackView ? (
            <Card title="Final board" testId="report-slack">
              <SlackBoard view={body.slackView} viewer={view.mode} opponent={persona.name} />
            </Card>
          ) : null}
          {body.penaltyView ? (
            <Card title="Kick map" testId="report-penalty">
              <PenaltyMap view={body.penaltyView} viewer={view.mode} opponent={persona.name} />
            </Card>
          ) : null}
          {hasKeyMoments(body) ? (
            <Card title="Key moments" note={body.note ?? undefined} testId="report-moments">
              <Moments moments={body.moments} />
            </Card>
          ) : view.status === 'ready' ? (
            body.note ? <p className="text-sm text-muted" data-testid="report-note">{body.note}</p> : null
          ) : (
            <Card title="Key moments" testId="report-moments-none">
              <p className="text-muted">{emptyReviewText(view.status, view.mode)}</p>
            </Card>
          )}
        </div>
        <aside className="grid min-w-0 content-start gap-6">
          {owner ? <OwnerSide view={view} delta={delta} link={link} /> : <PublicSide game={view.game} />}
          <Card title={`Who is ${persona.name}?`} testId="report-persona">
            <div className="flex items-center gap-3">
              <Avatar level={view.level} size={56} decorative />
              <p className="font-semibold">{persona.name}, {LEVEL_LABEL[view.level]}</p>
            </div>
            <p className="text-base text-muted">{bioFor(view.level, view.game)}</p>
            <p className="text-base">{verifiedStrength(registryFor(view.game), view.level) ? styleLine(view.level, view.game) : 'In training: this opponent\'s strength is still being checked.'}</p>
          </Card>
        </aside>
      </div>
    </article>
  )
}

function StateBlock({ title, text, testId }: { title: string; text: string; testId: string }) {
  return (
    <section className="grid max-w-md gap-2 py-10" data-testid={testId}>
      <h1 className="font-display text-display-md">{title}</h1>
      <p className="text-muted">{text}</p>
      <p>
        <Link to="/play" className={primary}>Back to the games</Link>
      </p>
    </section>
  )
}

function PublicSide({ game }: { game: GameId }) {
  const card = reportLearnsCard(game, registryFor(game))
  return (
    <Card title={card.title} testId="report-learns">
      <p className="text-base text-muted">{card.text}</p>
      <Link to="/ai" className="text-action underline">Meet the whole cast</Link>
    </Card>
  )
}

function OwnerSide({ view, delta, link }: { view: ReportView; delta: number | null; link: string }) {
  const owner = view.owner!
  const persona = personaFor(view.level)
  const learn = learningCopy(owner.learning, persona.name, view.game)
  return (
    <>
      {owner.rating && delta !== null ? (
        <Card title="Your rating" testId="report-rating">
          <p className="flex flex-wrap items-baseline gap-3">
            <span className="font-display text-display-md tabular" data-testid="report-rating-after">{owner.rating.after}</span>
            <span className={cn('rounded-full px-2.5 py-0.5 font-mono text-sm', delta >= 0 ? 'bg-good-soft text-good-ink' : 'bg-bad-soft text-bad-ink')} data-testid="report-rating-delta">
              {delta >= 0 ? '+' : ''}
              {delta}
            </span>
          </p>
          <p className="text-sm text-muted">
            {owner.rating.before} before this match
            {owner.rating.provisional ? `. ${provisionalNote(view.game).replace(/^provisional(, |: )/, 'Provisional: ')}.` : ''}
          </p>
        </Card>
      ) : PRODUCT.games[view.game].kind === 'realtime' ? (
        <Card title="Rating" testId="report-unranked">
          <p className="text-base text-muted">Real-time matches do not change a rating or appear on a leaderboard yet. This report is still yours to read and share.</p>
        </Card>
      ) : !owner.signedIn ? (
        <Card title="Guest result" testId="report-guest">
          <p className="text-base text-muted">You are not signed in, so this match has no rating. The moments and {persona.name}'s side are still here.</p>
          <Link to="/signin" className={primary}>Sign in</Link>
        </Card>
      ) : null}
      <RecordCard view={view} />
      <Card title={`${persona.name} and this match`} testId="report-learning">
        <p className={cn('text-base', learn.tone === 'warn' && 'text-warn-ink')} data-testid="report-learning-state" data-state={owner.learning.state}>
          <strong>{learn.title}.</strong> <span className="text-muted">{learn.text}</span>
        </p>
      </Card>
      <SharePanel view={view} link={link} />
    </>
  )
}

const RESULT_WORD = { win: 'W', loss: 'L', draw: 'D' } as const
const RESULT_NAME = { win: 'win', loss: 'loss', draw: 'draw' } as const

/** The owner's own record against this persona in this game, from their latest settled matches. */
function RecordCard({ view }: { view: ReportView }) {
  const rec = view.owner!.record
  const persona = personaFor(view.level)
  const total = rec.wins + rec.losses + rec.draws
  return (
    <Card title={`You vs ${persona.name}`} note={total > 0 ? `${PRODUCT.games[view.game].displayName}, ${matchesWindow(Math.min(total, RECORD_WINDOW))}` : undefined} testId="report-record">
      <p className="flex flex-wrap items-baseline gap-x-4 gap-y-1">
        <span className="font-display text-display-md tabular" data-testid="report-record-line">{recordLine(view.game, rec).line}</span>
        <span className="text-sm text-muted">{recordLine(view.game, rec).label}</span>
      </p>
      {rec.recent.length > 0 ? (
        <p className="flex flex-wrap items-center gap-2" data-testid="report-record-recent">
          <span className="text-sm text-muted">Latest, newest first</span>
          {rec.recent.map((o, i) => (
            <span key={i} title={RESULT_NAME[o]} className={cn('inline-grid size-7 place-items-center rounded-full font-mono text-sm', o === 'win' ? 'bg-good-soft text-good-ink' : o === 'loss' ? 'bg-bad-soft text-bad-ink' : 'bg-surface-2 text-ink')}>
              <span aria-hidden>{RESULT_WORD[o]}</span>
              <span className="sr-only">{RESULT_NAME[o]}</span>
            </span>
          ))}
        </p>
      ) : null}
    </Card>
  )
}

function SharePanel({ view, link }: { view: ReportView; link: string }) {
  const owner = view.owner!
  const router = useRouter()
  const [copied, setCopied] = useState(false)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)
  // Shown at once and put back if the server says no; the page data refreshes after a save.
  const [linkPublic, setLinkPublic] = useState(owner.linkPublic)
  const [showName, setShowName] = useState(owner.showName)
  const set = async (patch: { linkPublic?: boolean; showName?: boolean }) => {
    setBusy(true)
    setError(null)
    if (patch.linkPublic !== undefined) setLinkPublic(patch.linkPublic)
    if (patch.showName !== undefined) setShowName(patch.showName)
    try {
      const ok = await saveReportSettings({ data: { id: view.id, ...patch } })
      if (!ok) throw new Error('refused')
      await router.invalidate()
    } catch {
      setLinkPublic(owner.linkPublic)
      setShowName(owner.showName)
      setError('That did not save. Try again.')
    } finally {
      setBusy(false)
    }
  }
  const copy = async () => {
    try {
      await navigator.clipboard.writeText(link)
      setCopied(true)
      setTimeout(() => setCopied(false), 2000)
    } catch {
      setError('Copying is blocked here. Select the link and copy it by hand.')
    }
  }
  const saveImage = async () => {
    setError(null)
    try {
      const res = await fetch(`/report-card/${view.id}`)
      if (!res.ok) throw new Error('card')
      const url = URL.createObjectURL(new Blob([await res.text()], { type: 'image/svg+xml' }))
      const img = new Image()
      await new Promise<void>((ok, bad) => {
        img.onload = () => ok()
        img.onerror = () => bad(new Error('image'))
        img.src = url
      })
      const canvas = document.createElement('canvas')
      canvas.width = CARD_WIDTH
      canvas.height = CARD_HEIGHT
      canvas.getContext('2d')!.drawImage(img, 0, 0, CARD_WIDTH, CARD_HEIGHT)
      URL.revokeObjectURL(url)
      const png = await new Promise<Blob | null>((ok) => canvas.toBlob(ok, 'image/png'))
      if (!png) throw new Error('png')
      const a = document.createElement('a')
      a.href = URL.createObjectURL(png)
      a.download = `${PRODUCT.name.toLowerCase()}-match.png`
      a.click()
      URL.revokeObjectURL(a.href)
    } catch {
      setError('The image could not be made in this browser. The link still works.')
    }
  }
  return (
    <Card title="Share this match" testId="report-share">
      <label className="flex min-h-11 items-center gap-3">
        <input type="checkbox" className="size-5 accent-action" checked={linkPublic} disabled={busy} onChange={(e) => void set({ linkPublic: e.target.checked })} data-testid="share-public" />
        <span>Anyone with the link can open this report</span>
      </label>
      <p className="text-sm text-muted" data-testid="share-note">{shareControlsNote(personaFor(view.level).name, { signedIn: owner.signedIn, linkPublic, gameView: view.body ? hasGameView(view.body) : false, keyMoments: view.body ? hasKeyMoments(view.body) : false })}</p>
      {linkPublic ? (
        <>
          <p className="break-all rounded-control bg-surface-2 px-3 py-2 font-mono text-sm" data-testid="share-link">{link}</p>
          {owner.signedIn ? (
            <label className="flex min-h-11 items-center gap-3">
              <input type="checkbox" className="size-5 accent-action" checked={showName} disabled={busy} onChange={(e) => void set({ showName: e.target.checked })} data-testid="share-name" />
              <span>Show my name on the page</span>
            </label>
          ) : null}
          <div className="flex flex-wrap gap-2">
            <button type="button" onClick={() => void copy()} className={control} data-testid="share-copy">{copied ? 'Copied' : 'Copy link'}</button>
            <button type="button" onClick={() => void saveImage()} className={control} data-testid="share-image">Save image</button>
          </div>
        </>
      ) : (
        <p className="text-sm text-muted" data-testid="share-off">The link is off, so nobody else can open this report. Turn it on to share it.</p>
      )}
      {error ? <p role="alert" className="text-sm text-warn-ink">{error}</p> : null}
    </Card>
  )
}
