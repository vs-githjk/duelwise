import type { FrameReader } from './protocol'

/** What the self-play host needs from the bridge entry. The host attaches to process.stdin itself,
 *  pushes the chunks into `reader`, answers through `write`, and resolves with the process exit code. */
export interface SelfPlayIO {
  reader: FrameReader
  write(bytes: Uint8Array): Promise<void>
}
export type RunSelfPlay = (args: Record<string, string>, io: SelfPlayIO) => Promise<number>

/** The module that owns self-play for a game: chess has its own, every other game uses the shared host. */
export const selfPlaySpecifier = (game: string): string => (game === 'chess' ? './chess-selfplay' : './selfplay-host')

const isMissingModule = (e: unknown): boolean => {
  const err = e as { code?: string; message?: string }
  return err?.code === 'ERR_MODULE_NOT_FOUND' || /cannot find (module|package)/i.test(err?.message ?? '')
}

/** Lazily loads `runSelfPlay` from the owner's module. Returns null when the module or the export is
 *  not there yet (the caller exits 2). A module that exists but throws while loading is a real error. */
export async function loadSelfPlay(
  game: string,
  importer: (specifier: string) => Promise<unknown> = (s) => import(s),
): Promise<RunSelfPlay | null> {
  const spec = selfPlaySpecifier(game)
  try {
    const mod = (await importer(spec)) as { runSelfPlay?: RunSelfPlay | null }
    return typeof mod.runSelfPlay === 'function' ? mod.runSelfPlay : null
  } catch (e) {
    if (isMissingModule(e) && (e as Error).message.includes(spec.slice(2))) return null
    throw e
  }
}
