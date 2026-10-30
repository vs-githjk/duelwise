// Env bridge entry point:
//   bun packages/core/src/bridge/main.ts --game <id> --n <envs> --seed <s> [--level <lvl>] [--mode env|selfplay]
// stdout carries frames only; every log line goes to stderr.
//
// --mode selfplay delegates to the game's self-play owner (chess: ./chess-selfplay, others: ./selfplay-host),
// loaded lazily. The owner module must export
//   runSelfPlay(args: Record<string, string>, io: { reader: FrameReader; write(bytes: Uint8Array): Promise<void> }): Promise<number>
// where args are the parsed flags (game, n, seed, level, sims, ...), the host attaches to process.stdin itself
// and pushes chunks into io.reader, writes frames with io.write, and resolves with the process exit code.
// While the module or export is missing (exported as null or absent) this entry exits 2.
import { EnvHost, loadEnvFactory } from './env-host'
import { FrameReader, ProtocolError, encodeFrame } from './protocol'
import { loadSelfPlay } from './selfplay-loader'

function parseArgs(argv: string[]): Record<string, string> {
  const out: Record<string, string> = {}
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i]!
    if (!a.startsWith('--')) throw new Error(`unexpected argument ${a}`)
    const v = argv[i + 1]
    if (v === undefined || v.startsWith('--')) throw new Error(`missing value for ${a}`)
    out[a.slice(2)] = v
    i++
  }
  return out
}

async function main(): Promise<number> {
  const args = parseArgs(process.argv.slice(2))
  const mode = args.mode ?? 'env'
  if (mode !== 'env' && mode !== 'selfplay') throw new Error(`unknown --mode ${mode}`)
  if (!args.game) throw new Error('--game is required')
  const reader = new FrameReader()
  const write = (bytes: Uint8Array) =>
    new Promise<void>((resolve, reject) => process.stdout.write(bytes, (e) => (e ? reject(e) : resolve())))
  if (mode === 'selfplay') {
    const run = await loadSelfPlay(args.game)
    if (!run) {
      console.error('selfplay mode is provided by the self-play host (T12); this env host serves --mode env only')
      return 2
    }
    return run(args, { reader, write })
  }
  const n = Number(args.n ?? '1')
  const seed = Number(args.seed ?? '0')
  if (!Number.isInteger(n) || n < 1 || n > 4096) throw new Error('--n must be an integer in 1..4096')
  if (!Number.isInteger(seed)) throw new Error('--seed must be an integer')
  const factory = await loadEnvFactory(args.game)
  const host = new EnvHost(factory({ n, seed, level: args.level }))

  let chain = Promise.resolve()
  let exitCode: number | null = null
  const finish = new Promise<number>((resolve) => {
    const settle = (code: number) => {
      if (exitCode === null) {
        exitCode = code
        chain.then(() => resolve(code))
      }
    }
    process.stdin.on('data', (chunk: Buffer) => {
      try {
        reader.push(chunk)
        for (const frame of reader.drain()) {
          const res = host.handle(frame)
          if (res === 'close') return settle(0)
          chain = chain.then(() => write(encodeFrame(res.header, res.payload)))
        }
      } catch (e) {
        console.error('bridge: ' + (e as Error).message)
        if (e instanceof ProtocolError) settle(3)
        else settle(1)
      }
    })
    process.stdin.on('end', () => settle(0))
  })
  return finish
}

main().then(
  (code) => process.exit(code),
  (e) => {
    console.error('bridge: ' + (e as Error).message)
    process.exit(1)
  },
)
