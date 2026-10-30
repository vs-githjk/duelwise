import { useEffect, useRef, useState } from 'react'
import {
  ACESFilmicToneMapping, AmbientLight, CircleGeometry, Color, DirectionalLight, HemisphereLight, Mesh, MeshStandardMaterial, PerspectiveCamera, Scene, SRGBColorSpace, WebGLRenderer,
} from 'three'
import { M } from '@duelwise/core/src/games/fighter/moves'
import { ANIMATION_MAP, CLIPS } from './render/animation-map'
import { CHARACTERS, FighterRig, loadCharacterAssets, type CharacterAssets } from './render/characters'
import type { FighterChoice } from './roster'

// The two rigs, idling, on the select screen (R30: it was text only). It uses the same rigs, costumes and idle
// clip as the match, in a small scene of its own: you on the left in your colourway, the AI on the right in the
// one it will take. Under reduced motion it draws one still frame.

let assetsPromise: Promise<CharacterAssets> | null = null
const assets = (): Promise<CharacterAssets> => (assetsPromise ??= loadCharacterAssets().catch((e) => {
  assetsPromise = null
  throw e
}))

const FACE = Math.PI / 2 - 0.35

export function SelectPreview({ me, ai }: { me: FighterChoice; ai: FighterChoice }) {
  const host = useRef<HTMLDivElement>(null)
  const [failed, setFailed] = useState(false)

  useEffect(() => {
    const el = host.current
    if (!el) return
    let stop = false
    let raf = 0
    let renderer: WebGLRenderer | null = null
    const rigs: FighterRig[] = []
    let cleanup = () => {}
    ;(async () => {
      try {
        renderer = new WebGLRenderer({ antialias: true, alpha: true })
      } catch {
        setFailed(true)
        return
      }
      renderer.outputColorSpace = SRGBColorSpace
      renderer.toneMapping = ACESFilmicToneMapping
      renderer.setPixelRatio(Math.min(window.devicePixelRatio || 1, 2))
      const cv = renderer.domElement
      cv.className = 'block size-full'
      cv.setAttribute('role', 'img')
      cv.setAttribute('aria-label', 'Your fighter on the left and the AI fighter on the right, standing ready')
      el.appendChild(cv)
      const scene = new Scene()
      scene.add(new HemisphereLight(0xcfe0ff, 0x2a2018, 1.1), new AmbientLight(0xffffff, 0.35))
      const key = new DirectionalLight(0xffe2c0, 2.4)
      key.position.set(2, 4, 4)
      scene.add(key)
      const floor = new Mesh(new CircleGeometry(2.6, 48), new MeshStandardMaterial({ color: new Color(0x1a1d24), roughness: 0.9 }))
      floor.rotation.x = -Math.PI / 2
      scene.add(floor)
      const cam = new PerspectiveCamera(26, 16 / 9, 0.1, 50)
      const resize = () => {
        const w = Math.max(1, el.clientWidth)
        const h = Math.max(1, el.clientHeight)
        renderer!.setSize(w, h, false)
        cam.aspect = w / h
        cam.updateProjectionMatrix()
        cam.position.set(0, 1.15, 5.8 * Math.max(1, 2.3 / (w / h)))
        cam.lookAt(0, 0.9, 0)
      }
      resize()
      const ro = new ResizeObserver(resize)
      ro.observe(el)
      let a: CharacterAssets
      try {
        a = await assets()
      } catch {
        if (!stop) setFailed(true)
        ro.disconnect()
        return
      }
      if (stop) {
        ro.disconnect()
        return
      }
      for (const [i, c] of [me, ai].entries()) {
        const def = CHARACTERS[c.character]!
        const rig = new FighterRig(def, def.colorways[c.colorway] ?? def.colorways[0]!, a)
        rig.root.position.set(i === 0 ? -0.95 : 0.95, 0, 0)
        rig.root.rotation.y = i === 0 ? FACE : -FACE
        scene.add(rig.root)
        rigs.push(rig)
      }
      const clip = ANIMATION_MAP[M.IDLE]!.clip
      const dur = CLIPS[clip]!.duration
      const still = window.matchMedia?.('(prefers-reduced-motion: reduce)').matches ?? false
      const t0 = performance.now()
      const draw = () => {
        if (stop) return
        const t = still ? 0 : (performance.now() - t0) / 1000
        // The two idle loops are offset by a fraction so they do not breathe in lockstep.
        rigs.forEach((r, i) => r.pose([{ clip, time: (t + i * 0.37) % dur, weight: 1 }]))
        renderer!.render(scene, cam)
        if (!still) raf = requestAnimationFrame(draw)
      }
      draw()
      cleanup = () => ro.disconnect()
    })()
    return () => {
      stop = true
      cancelAnimationFrame(raf)
      cleanup()
      rigs.forEach((r) => r.dispose())
      renderer?.dispose()
      renderer?.domElement.remove()
    }
  }, [me.character, me.colorway, ai.character, ai.colorway])

  if (failed) return null
  return <div ref={host} className="aspect-[16/6.5] w-full overflow-hidden rounded-card border border-line bg-surface-2" data-testid="select-preview" />
}
