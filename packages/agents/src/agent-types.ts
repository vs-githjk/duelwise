export interface Agent {
  /** Returns the chosen action as integers (turn games: one encoded action; realtime: one per action dimension). */
  act(obs: unknown, state?: unknown): Promise<number[]>
  /** `seat`, when given, replaces the seat the agent was made for: a page learns the player's side only after the server row exists, which is after the opponent is built. */
  reset(seed: number, seat?: 0 | 1): void
  dispose(): void
}

/** Test and preview hooks; real agents ignore what they do not need. */
export interface AgentOpts {
  /** Core to ask for legal moves (stubs only). Defaults to getCore(game). */
  core?: import('@duelwise/core/src/types').GameCore<any, any, any>
  /** Seat this agent plays. Default 1 (the human is seat 0). */
  seat?: 0 | 1
}

export type PreviewAgent = Agent & { preview: boolean }
