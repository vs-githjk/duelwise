import type { SessionOptions } from './session'

/**
 * What the two-device matches run with (slice 2, S7/S8). The S5 defaults (window 8, keepalive 6) left the friend's confirmed frame up to 5
 * frames stale when an input is simply held, so on a poor link the sim hit the window and froze. Measured with netsim, 6000 frames per
 * game, mean over fighter, arena and puck (two logs each):
 *
 *   link   setting       frozen ticks   messages/s per client   deepest guess
 *   wifi   window 8  k 6    3.7%            16.5                    8
 *   wifi   window 12 k 4    0.5%            19.7                   12
 *   poor   window 8  k 6   24.2%            13.4                    8
 *   poor   window 12 k 4    1.8%            19.6                   12
 *   lan    either           0%              17 / 20                 6 / 4
 *
 * Choice: window 12 AND keepalive 4. A wider window alone (12, k 6) still froze 4.2% on the poor link; a shorter keepalive alone (8, k 3)
 * still froze 14.9%. The cost is +17% messages on held input (the 30 a second cap while inputs change is untouched, so the budget
 * estimates stand) and a guess may be corrected up to 12 frames (200 ms) late; sim re-runs cost microseconds per frame.
 */
export const REALTIME_TUNING: { session: SessionOptions; every: number; keepalive: number } = {
  session: { delay: 2, window: 12 },
  every: 2,
  keepalive: 4,
}
