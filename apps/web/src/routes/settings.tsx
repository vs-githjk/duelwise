import { Link, createFileRoute, getRouteApi, useNavigate, useRouter } from '@tanstack/react-router'
import { PRODUCT } from '@duelwise/core/src/product'
import { settingsTrainingLine } from '../lib/honest-copy'
import { allRegistries } from '../lib/registries'
import { TrainingToggle, useTrainingSettings } from '../components/TrainingNotice'
import { useEffect, useId, useState, useSyncExternalStore, type ReactNode } from 'react'
import { authClient } from '../lib/auth-client'
import { forgetPrivateData } from '../lib/pwa'
import { deleteMyAccount } from '../server/account-fns'
import { forgetThisDevice, getMyIdentity, saveBoardVisibility } from '../server/identity-fns'
import { NameField } from '../components/IdentityCard'
import { getVolume, isMuted, setMuted, subscribeAudio } from '../lib/audio'
import { forgetLocal } from '../lib/progress'
import { readVoicePref, speechSupported, writeVoicePref } from '../lib/speech'

export const Route = createFileRoute('/settings')({
  head: () => ({ meta: [{ title: `Settings | ${PRODUCT.name}` }] }),
  component: Page,
})

const root = getRouteApi('__root__')

/** One settings row: what it is, one plain sentence, and its control. */
function Row({ title, children, control, testId }: { title: string; children: ReactNode; control?: ReactNode; testId?: string }) {
  return (
    <section className="grid gap-2 rounded-card border border-line bg-surface p-4 shadow-card md:p-5" data-testid={testId}>
      <h2 className="font-display text-display-sm">{title}</h2>
      <div className="text-sm text-muted">{children}</div>
      {control ? <div>{control}</div> : null}
    </section>
  )
}

/** The "Show me on the leaderboard" switch, for guests and signed-in players alike. The board lists the name you typed, or "guest" and four characters. */
function BoardSwitch() {
  const id = useId()
  const [show, setShow] = useState<boolean | null>(null)
  const [busy, setBusy] = useState(false)
  useEffect(() => {
    let live = true
    getMyIdentity()
      .then((r) => live && setShow(r.showOnBoard))
      .catch(() => live && setShow(true))
    return () => {
      live = false
    }
  }, [])
  async function change(next: boolean) {
    setShow(next)
    setBusy(true)
    try {
      setShow((await saveBoardVisibility({ data: { show: next } })).show)
    } catch {
      setShow((await getMyIdentity().catch(() => null))?.showOnBoard ?? true)
    } finally {
      setBusy(false)
    }
  }
  if (show === null) return <p className="text-muted">Loading</p>
  return (
    <label htmlFor={id} className="inline-flex min-h-11 cursor-pointer items-center gap-3">
      <input id={id} type="checkbox" role="switch" className="size-5 accent-action" checked={show} disabled={busy} onChange={(e) => void change(e.target.checked)} />
      <span className="font-medium">Show me on the leaderboard</span>
    </label>
  )
}

/** Master sound (the mute the games use) and the opponent's spoken line, which follows it. */
function SoundRow() {
  useSyncExternalStore(subscribeAudio, getVolume, getVolume)
  const muted = useSyncExternalStore(subscribeAudio, isMuted, () => false)
  const [voice, setVoice] = useState(false)
  const [can, setCan] = useState(false)
  useEffect(() => {
    setCan(speechSupported())
    setVoice(readVoicePref() === 'on')
  }, [])
  const idSound = useId()
  const idVoice = useId()
  return (
    <div className="grid gap-1">
      <label htmlFor={idSound} className="inline-flex min-h-11 cursor-pointer items-center gap-3">
        <input id={idSound} type="checkbox" role="switch" className="size-5 accent-action" checked={!muted} onChange={(e) => setMuted(!e.target.checked)} />
        <span className="font-medium">Sound</span>
      </label>
      {can ? (
        <label htmlFor={idVoice} className="inline-flex min-h-11 cursor-pointer items-center gap-3">
          <input
            id={idVoice}
            type="checkbox"
            role="switch"
            className="size-5 accent-action"
            checked={voice && !muted}
            disabled={muted}
            onChange={(e) => {
              writeVoicePref(e.target.checked ? 'on' : 'off')
              setVoice(e.target.checked)
            }}
          />
          <span className="font-medium">Opponent speaks after a match</span>
        </label>
      ) : null}
    </div>
  )
}

function Page() {
  const user = root.useLoaderData()?.user ?? null
  const router = useRouter()
  const navigate = useNavigate()
  const { settings, busy, setAllowed } = useTrainingSettings()
  const [confirming, setConfirming] = useState(false)
  const [deleting, setDeleting] = useState(false)
  const [deleteError, setDeleteError] = useState(false)
  async function deleteAccount() {
    setDeleting(true)
    setDeleteError(false)
    try {
      const r = await deleteMyAccount()
      if (!r.deleted) throw new Error('not deleted')
      await authClient.signOut().catch(() => {})
      await forgetPrivateData()
      await router.invalidate()
      await navigate({ to: '/' })
    } catch {
      setDeleteError(true)
      setDeleting(false)
    }
  }
  const [forgotten, setForgotten] = useState(false)
  async function forgetMe() {
    forgetLocal()
    await forgetThisDevice().catch(() => {})
    await forgetPrivateData()
    setForgotten(true)
  }
  return (
    <section className="grid max-w-2xl gap-4 py-8">
      <h1 className="font-display text-display-md md:text-display-lg">Settings</h1>
      <Row title="Your name" testId="name-settings" control={<NameField />}>
        The board shows this name. It is the only thing Duelwise asks for. Leave it empty and the board shows guest and four characters.
      </Row>
      <Row
        title="Keep my name on other devices"
        testId="keep-name"
        control={
          user ? undefined : (
            <Link to="/signin" className="inline-flex min-h-11 items-center rounded-full bg-action px-5 font-semibold text-action-ink">
              Continue with Google
            </Link>
          )
        }
      >
        {user ? (
          <>
            Signed in as <span className="font-semibold text-ink">{user.name}</span>. Your name, your path and your calls follow your account.{' '}
            <button
              type="button"
              className="font-semibold text-action underline"
              onClick={async () => {
                await authClient.signOut()
                await forgetPrivateData()
                await router.invalidate()
                await navigate({ to: '/' })
              }}
            >
              Sign out
            </button>
          </>
        ) : (
          <>You are playing as a guest, remembered by this browser only. Signing in is never required; it gets you a rating and carries your name to other devices.</>
        )}
      </Row>
      <Row title="Let my matches help train the agents" testId="training-settings" control={settings ? <TrainingToggle allowed={settings.trainingAllowed} busy={busy} onChange={setAllowed} /> : <p className="text-muted">Loading</p>}>
        {settingsTrainingLine(allRegistries())}
      </Row>
      <Row title="Leaderboard" testId={user ? 'leaderboard-settings' : 'board-settings'} control={<BoardSwitch />}>
        Wins at each level, last 30 days, for everybody. Switch this off to stay off every board; your own path and report stay yours.
      </Row>
      <Row title="Sound" testId="sound-settings" control={<SoundRow />}>
        One switch for every game sound. The opponent's line after a match is spoken by your browser's own voice, never over the network.
      </Row>
      {user ? null : (
        <Row
          title="Forget me on this device"
          testId="forget-me"
          control={
            <button type="button" onClick={() => void forgetMe()} className="inline-flex min-h-11 items-center rounded-full border border-line bg-surface px-5 font-semibold">
              Forget me here
            </button>
          }
        >
          Clears your name, your path, your calls and your sound choices from this browser, and this browser's guest identity. Rows already on the board keep the name they were posted with.
          {forgotten ? <span className="mt-1 block font-semibold text-ink" role="status">Done. This browser has forgotten you.</span> : null}
        </Row>
      )}
      {user ? (
        <div className="grid gap-2" data-testid="delete-account">
          <h2 className="font-display text-display-sm">Delete account</h2>
          <p className="text-muted">
            Removes your account, ratings and every match you played, and signs you out. This cannot be undone.{' '}
            <Link to="/privacy" className="text-action underline">
              Privacy
            </Link>
          </p>
          {confirming ? (
            <div className="flex flex-wrap items-center gap-3">
              <button type="button" disabled={deleting} onClick={() => void deleteAccount()} className="inline-flex min-h-11 items-center rounded-control border border-bad bg-bad-soft px-4 font-semibold text-bad-ink disabled:opacity-60">
                Yes, delete everything
              </button>
              <button type="button" disabled={deleting} onClick={() => setConfirming(false)} className="inline-flex min-h-11 items-center rounded-control border border-line bg-surface px-4 font-semibold">
                Cancel
              </button>
            </div>
          ) : (
            <div>
              <button type="button" onClick={() => setConfirming(true)} className="inline-flex min-h-11 items-center rounded-control border border-line bg-surface px-4 font-semibold">
                Delete my account
              </button>
            </div>
          )}
          {deleteError ? (
            <p role="alert" className="text-bad-ink">
              Could not delete the account. Please try again.
            </p>
          ) : null}
        </div>
      ) : null}
    </section>
  )
}
