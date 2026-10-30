import { expect, test } from 'bun:test'
import { join } from 'node:path'
import { servedBotGame } from './fighter'

test('served fighter plays a complete bot match on either seat', async () => {
  const bytes = new Uint8Array(await Bun.file(join(import.meta.dir, '../../../../apps/web/public/agents/fighter/v1/hard.onnx')).arrayBuffer())
  for (const seat of [0, 1] as const) {
    const result = await servedBotGame({ level: 'hard', bytes }, 'throwtap', seat, 9100)
    expect([0, 0.5, 1]).toContain(result)
  }
})
