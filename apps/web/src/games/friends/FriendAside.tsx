import { useState, type CSSProperties, type ReactNode } from 'react'
import { TWO_DEVICE_KEPT } from '../../lib/friend-copy'

export interface FriendPlayer {
  name: string
  /** "White", "yellow". */
  side: string
  /** Inline style for the dot, so the same colour variable the board uses paints it. */
  swatch: CSSProperties
}

/**
 * The card beside (or under) a friend board: who plays which side, anything the game adds (the move list), and Resign for the player to move.
 * The Resign question names the person who would resign, so the wrong person cannot give up by passing the phone at the wrong moment unnoticed.
 */
export function FriendAside({ twoDevices = false, players, mover, playing, onResign, resignable = true, resignLabel, children }: { /** Two devices: the result is kept, so the note must not say "not saved". */ twoDevices?: boolean; players: [FriendPlayer, FriendPlayer]; mover: 0 | 1; playing: boolean; onResign: () => void; /** Two devices: the confirm button says this instead of naming a player (whoever holds the device is always the one resigning). */ resignLabel?: string; /** False while a hand-over curtain is up: whoever holds the device must not be able to resign for the person it is being passed to. */ resignable?: boolean; children?: ReactNode }) {
  const [confirming, setConfirming] = useState(false)
  return (
    <div className="grid gap-4" data-testid="friend-aside">
      <section className="grid gap-2 rounded-card border border-line bg-surface p-4" data-testid="friend-players" aria-label="Players">
        <b className="font-display text-display-sm">Friend game</b>
        <ul className="grid gap-1.5 text-sm">
          {players.map((p, i) => (
            <li key={i} className="flex items-center gap-2" data-active={playing && mover === i ? '' : undefined}>
              <i className="inline-block size-4 shrink-0 rounded-full border-2 border-muted" style={p.swatch} aria-hidden="true" />
              <span className="min-w-0 truncate">
                <b className="font-semibold">{p.name}</b>, {p.side}
              </span>
            </li>
          ))}
        </ul>
        <p className="text-xs text-muted">{twoDevices ? TWO_DEVICE_KEPT : 'Not rated and not saved.'}</p>
      </section>
      {children}
      {playing && resignable ? (
        confirming ? (
          <div className="flex flex-wrap items-center gap-2" role="group" aria-label="Confirm resign">
            <button
              type="button"
              onClick={() => {
                setConfirming(false)
                onResign()
              }}
              className="min-h-11 rounded-control bg-bad px-4 text-sm font-semibold text-white"
              data-testid="friend-resign-yes"
            >
              {resignLabel ?? `Yes, ${players[mover].name} resigns`}
            </button>
            <button type="button" onClick={() => setConfirming(false)} className="min-h-11 rounded-control border border-line bg-surface px-4 text-sm font-semibold">
              Keep playing
            </button>
          </div>
        ) : (
          <button type="button" onClick={() => setConfirming(true)} className="min-h-11 justify-self-start rounded-control border border-line bg-surface px-4 text-sm font-semibold" data-testid="friend-resign">
            Resign
          </button>
        )
      ) : null}
    </div>
  )
}
