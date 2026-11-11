import { describe, expect, test } from 'bun:test'
import { NAME_LOAD_FAILED, saveNameLazily } from './save-name-lazy'

describe('saveNameLazily', () => {
  test('a chunk that fails to load gives the retry line instead of throwing', async () => {
    const r = await saveNameLazily('Ada', () => Promise.reject(new Error('Failed to fetch dynamically imported module')))
    expect(r).toEqual({ ok: false, error: NAME_LOAD_FAILED })
    expect(NAME_LOAD_FAILED).toBe('Could not check that name. Try again.')
  })

  test('a loaded rule decides: its answer passes through', async () => {
    const ok = await saveNameLazily('Ada', async () => ({ saveNameChecked: async (n: string) => ({ ok: true as const, name: n, saved: true }) }))
    expect(ok).toEqual({ ok: true, name: 'Ada', saved: true })
    const no = await saveNameLazily('x', async () => ({ saveNameChecked: async () => ({ ok: false as const, error: 'nope' }) }))
    expect(no).toEqual({ ok: false, error: 'nope' })
  })
})
