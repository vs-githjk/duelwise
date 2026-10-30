import { ARMOR_PRICE, WEAPONS, type Weapon } from '@duelwise/core/src/games/arena/weapons'

// The buy menu (design pass 2). The sim sells three things, so the menu lists three: the two rifles and
// armour; the free sidearm is what you start with. Each rifle shows price, damage, fire rate and magazine
// as bars against the best of the three, and the kill reward. Keys 1 to 3 buy (the page handles them, so the
// menu works while the mouse is captured); the buttons work when it is not. The AI buys under the same rules
// and with the same money.

export interface BuyMenuProps {
  money: number
  weapon: number
  armor: number
  /** Whole seconds of buy time left. */
  seconds: number
  onBuy: (choice: 1 | 2 | 3) => void
  /** What the AI bought, once known, for the honest "same rules" line. */
  aiNote?: string
}

const RIFLES = WEAPONS.filter((w) => w.price > 0)
const MAX = {
  damage: Math.max(...RIFLES.map((w) => w.damage)),
  rate: Math.max(...RIFLES.map((w) => 60 / w.cycle)),
  magazine: Math.max(...RIFLES.map((w) => w.magazine)),
}
const fmt = (n: number) => n.toLocaleString('en-US')

function Bars({ w }: { w: Weapon }) {
  const bar = (label: string, value: number, max: number, text: string) => (
    <div>
      <span>
        {label} {text}
      </span>
      <i style={{ ['--w' as string]: `${Math.round((value / max) * 100)}%` }} />
    </div>
  )
  return (
    <div className="bars">
      {bar('Damage', w.damage, MAX.damage, String(w.damage))}
      {bar('Rate', 60 / w.cycle, MAX.rate, `${(60 / w.cycle).toFixed(1)}/s`)}
      {bar('Magazine', w.magazine, MAX.magazine, String(w.magazine))}
    </div>
  )
}

export function BuyMenu({ money, weapon, armor, seconds, onBuy, aiNote }: BuyMenuProps) {
  return (
    <section className="ab-menu" aria-label="Buy menu" data-testid="buy-menu" onMouseDown={(e) => e.stopPropagation()}>
      <h3>
        Buy phase, {seconds} s <span data-testid="buy-money">${fmt(money)}</span>
      </h3>
      {RIFLES.map((w) => {
        const owned = weapon === w.id
        const short = money < w.price
        return (
          <button
            key={w.id}
            type="button"
            className={`ab-item${owned ? ' owned' : ''}`}
            disabled={owned || short}
            onClick={() => onBuy(w.id as 1 | 2)}
            data-testid={`buy-${w.name.toLowerCase()}`}
            aria-label={`Buy ${w.name}, $${fmt(w.price)}${owned ? ', owned' : short ? ', not enough money' : ''}`}
          >
            <kbd>{w.id}</kbd>
            <span className="nm">
              {w.name}
              <small>{w.auto === 1 ? 'automatic' : 'semi-automatic'} · kill ${fmt(w.killReward)}</small>
            </span>
            <span className="pr">${fmt(w.price)}</span>
            <Bars w={w} />
            {owned ? <span className="why">Equipped.</span> : null}
          </button>
        )
      })}
      <button
        type="button"
        className={`ab-item${armor > 0 ? ' owned' : ''}`}
        disabled={armor >= 100 || money < ARMOR_PRICE}
        onClick={() => onBuy(3)}
        data-testid="buy-armor"
        aria-label={`Buy armour, $${fmt(ARMOR_PRICE)}${armor >= 100 ? ', owned' : money < ARMOR_PRICE ? ', not enough money' : ''}`}
      >
        <kbd>3</kbd>
        <span className="nm">Armour</span>
        <span className="pr">${fmt(ARMOR_PRICE)}</span>
        <span className="why">{armor >= 100 ? 'Equipped.' : 'Takes part of every hit to the body until it is spent. Legs are not covered.'}</span>
      </button>
      <p className="note">
        You start with the {WEAPONS[0]!.name}, a free semi-automatic sidearm. The opponent buys under the same rules and with the same money. {aiNote ?? ''}
      </p>
    </section>
  )
}
