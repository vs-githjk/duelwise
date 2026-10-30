// Fighter sim constants. All state math is integer or IEEE basic ops. The reference for each
// number is in docs/game-design/fighter.md.

export const FPS = 60
export const MAX_HEALTH = 10000
export const ROUND_SECONDS = 99
export const ROUND_FRAMES = ROUND_SECONDS * FPS
export const INTRO_FRAMES = 30
export const ROUND_END_FRAMES = 90
export const ROUNDS_TO_WIN = 2
export const MAX_ROUNDS = 5

// World units: a fighter is 60 wide and 170 tall.
export const STAGE_HALF = 800
export const START_X = 250
/**
 * The most two fighters may stand apart (fighter-env-3, R30). The camera shows about 935 units at its
 * widest, so a bigger gap would put a fighter off screen. Nobody can walk, dash or jump further apart
 * than this; the stage is 1600 wide, so the corners still matter.
 */
export const MAX_SEPARATION = 850
export const PUSH_HALF = 30
export const PUSH_MAX_Y = 100

export const WALK_FORWARD = 4
export const WALK_BACK = 3
export const DASH_FORWARD_SPEED = 9
export const DASH_FORWARD_FRAMES = 17
export const DASH_BACK_SPEED = 7
export const DASH_BACK_FRAMES = 22
export const DASH_BACK_MOVE_FRAMES = 16
export const DASH_BACK_INVULN_FRAMES = 6
export const DASH_TAP_WINDOW = 12

export const PREJUMP_FRAMES = 4
export const JUMP_VY = 22
export const GRAVITY = 1
export const JUMP_VX = 6

export const INPUT_BUFFER = 4

/**
 * LC1 (tinderbox-r3): frames between an agent's decision and the first sim frame its input is held. The page asks a worker
 * for the answer and applies it from the next step, so a decision made at frame f is held from f + 1; the env trains and
 * the gate measures with the same lag. An episode draws the lag from AGENT_INPUT_LAGS by its seed (1 on even seeds, 2 on odd
 * ones, a slow machine), so a net does not rely on the lag being exactly one frame. Only seats played by the learner lag:
 * scripted bots stand for a human at the keyboard, whose key goes in at once.
 */
export const AGENT_INPUT_LAGS = [1, 2] as const
/** The lag the page applies when the worker answers in time (the next step). It is one of AGENT_INPUT_LAGS, so every net is trained and gated on it. */
export const PAGE_INPUT_LAG = 1
export const agentInputLagFor = (seed: number): number => AGENT_INPUT_LAGS[(seed >>> 0) % AGENT_INPUT_LAGS.length]!

export const THROW_RANGE = 70
export const THROW_TECH_WINDOW = 7
export const THROW_TECH_PUSH = 40
export const THROW_TECH_STUN = 14
export const THROW_HOLD_FRAMES = 10
export const THROW_LAUNCH_VY = 8
export const KNOCKDOWN_LIE_FRAMES = 20
export const KNOCKDOWN_LAUNCH_VY = 10
export const KNOCKDOWN_LAUNCH_VX = 3

// Gauges. Drive-style gauge ("surge") has six bars, the super meter three.
export const SURGE_MAX = 60000
export const SUPER_MAX = 30000
export const SUPER_LEVEL1_COST = 10000
export const SURGE_REGEN_PER_FRAME = 10
export const OVERHEAT_FRAMES = 300
export const OVERHEAT_RESTORE = 15000
export const DEFLECT_COST = 2500
export const DEFLECT_REFUND = 2000
export const RUSH_COST = 10000
export const RUSH_CANCEL_COST = 30000
export const BREAKER_COST = 10000
export const DEFLECT_ATTACKER_STUN = 24
export const DEFLECT_ATTACKER_HITSTOP = 12
export const DEFLECT_RECOVER_FRAMES = 4
export const BREAKER_ARMOR_DAMAGE_DIV = 4

// Combo scaling in percent by number of earlier hits in the combo.
export const COMBO_SCALE = [100, 100, 90, 80, 70, 60, 50, 40, 30, 20, 10] as const
export const COUNTER_PERCENT = 120
export const PUNISH_PERCENT = 150
export const COUNTER_EXTRA_STUN = 2
export const PUNISH_EXTRA_STUN = 4
export const OVERHEAT_CHIP_DIV = 4

// Hurtboxes, relative to the feet, facing right.
export const STAND_HURT = [-26, 0, 26, 170] as const
export const CROUCH_HURT = [-28, 0, 28, 105] as const
export const AIR_HURT_Y0 = 20
export const AIR_HURT_Y1 = 160
export const AIR_HURT_HALF = 26
