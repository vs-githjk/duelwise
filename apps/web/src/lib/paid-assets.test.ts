import { expect, test } from 'bun:test'
import { paidAssetUrl } from './paid-assets'

test('uses the env base when set, trimming trailing slashes', () => {
  expect(paidAssetUrl('arena/a.glb', 'https://x.public.blob.vercel-storage.com')).toBe('https://x.public.blob.vercel-storage.com/arena/a.glb')
  expect(paidAssetUrl('arena/a.glb', 'https://x.example/base//')).toBe('https://x.example/base/arena/a.glb')
})

test('uses the local dev path when the env base is unset or blank', () => {
  expect(paidAssetUrl('arena/a.glb', undefined)).toBe('/paid/arena/a.glb')
  expect(paidAssetUrl('arena/a.glb', '  ')).toBe('/paid/arena/a.glb')
})
