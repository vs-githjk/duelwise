import {
  AdditiveBlending, BoxGeometry, BufferAttribute, BufferGeometry, CanvasTexture, Color, CylinderGeometry, DirectionalLight, DoubleSide, FogExp2, Group, HemisphereLight,
  LinearFilter, Mesh, MeshBasicMaterial, MeshStandardMaterial, PMREMGenerator, PlaneGeometry, Points, PointsMaterial, PointLight, RepeatWrapping,
  SpotLight, SRGBColorSpace, Texture, TextureLoader, type Scene, type WebGLRenderer,
} from 'three'
import { HDRLoader } from 'three/examples/jsm/loaders/HDRLoader.js'

// "Foundry Yard": furnace key light upstage left (about 2600 K), cold skylight fill on the right
// (about 7000 K, a third of the key), wet concrete floor plates, a rusted back wall with gantry and chain-link
// silhouettes, and drifting sparks. CC0 sources: ambientCG Concrete034, Poly Haven rusty_painted_metal
// and the unfinished_office_night HDRI (docs/third-party/fighter-assets.md). Everything else is code.

const BASE = '/assets/fighter'
export const STAGE_HALF_UNITS = 10

export interface StageOptions {
  /** Cast shadows and add the spark field (off in the low quality tier). */
  quality: 'high' | 'low'
}

export interface Stage {
  group: Group
  /** Advance flicker and sparks by dt seconds. */
  update(dt: number, t: number): void
  /** Resolves when the textures and the HDRI are in. */
  ready: Promise<void>
  dispose(): void
}

function radialGlowTexture(): CanvasTexture {
  const c = document.createElement('canvas')
  c.width = c.height = 128
  const g = c.getContext('2d')!
  const grad = g.createRadialGradient(64, 64, 0, 64, 64, 64)
  grad.addColorStop(0, 'rgba(255,255,255,1)')
  grad.addColorStop(0.45, 'rgba(255,255,255,0.35)')
  grad.addColorStop(1, 'rgba(255,255,255,0)')
  g.fillStyle = grad
  g.fillRect(0, 0, 128, 128)
  return new CanvasTexture(c)
}

/** The furnace mouth's emissive map: a white-hot core fading to dull red at the edges, crossed by dark grate bars and mottled with coals. Deterministic, so a capture repeats. */
export function coalTexture(): CanvasTexture {
  const c = document.createElement('canvas')
  c.width = 256
  c.height = 128
  const g = c.getContext('2d')!
  const grad = g.createRadialGradient(128, 78, 4, 128, 78, 130)
  grad.addColorStop(0, '#fff2c0')
  grad.addColorStop(0.3, '#ffa43a')
  grad.addColorStop(0.7, '#b8350c')
  grad.addColorStop(1, '#2a0a04')
  g.fillStyle = grad
  g.fillRect(0, 0, 256, 128)
  let seed = 7
  const rnd = (): number => ((seed = (seed * 1664525 + 1013904223) >>> 0) / 4294967296)
  for (let i = 0; i < 90; i++) {
    g.fillStyle = `rgba(${rnd() < 0.5 ? '255,220,140' : '60,12,4'},${0.12 + rnd() * 0.3})`
    g.beginPath()
    g.arc(rnd() * 256, 40 + rnd() * 88, 3 + rnd() * 9, 0, Math.PI * 2)
    g.fill()
  }
  g.fillStyle = 'rgba(14,6,3,0.9)'
  for (let x = 16; x < 256; x += 32) g.fillRect(x, 0, 6, 128)
  g.fillRect(0, 10, 256, 5)
  return new CanvasTexture(c)
}

function chainLinkTexture(): CanvasTexture {
  const c = document.createElement('canvas')
  c.width = c.height = 128
  const g = c.getContext('2d')!
  g.clearRect(0, 0, 128, 128)
  g.strokeStyle = 'rgba(255,255,255,0.9)'
  g.lineWidth = 3
  g.beginPath()
  for (const [x0, y0, x1, y1] of [[0, 0, 128, 128], [128, 0, 0, 128], [-64, 64, 64, 192], [64, -64, 192, 64], [64, 192, 192, 64], [-64, 64, 64, -64]] as const) {
    g.moveTo(x0, y0)
    g.lineTo(x1, y1)
  }
  g.stroke()
  const t = new CanvasTexture(c)
  t.wrapS = t.wrapT = RepeatWrapping
  t.repeat.set(36, 8)
  t.colorSpace = SRGBColorSpace
  return t
}

export function createStage(scene: Scene, renderer: WebGLRenderer, opts: StageOptions): Stage {
  const group = new Group()
  const disposables: Array<{ dispose(): void }> = []
  const track = <T extends { dispose(): void }>(o: T): T => {
    disposables.push(o)
    return o
  }
  const loader = new TextureLoader()
  const loading: Array<Promise<void>> = []
  const tex = (url: string, srgb: boolean, rx: number, ry: number): Texture => {
    let done!: () => void
    let fail!: (e: unknown) => void
    loading.push(new Promise<void>((res, rej) => { done = res; fail = rej }))
    const t = track(loader.load(url, () => done(), undefined, () => fail(new Error(`stage texture failed to load: ${url}`))))
    t.wrapS = t.wrapT = RepeatWrapping
    t.repeat.set(rx, ry)
    t.anisotropy = 4
    if (srgb) t.colorSpace = SRGBColorSpace
    return t
  }

  scene.background = new Color(0x0c0806)
  scene.fog = new FogExp2(0x140d09, 0.05)

  // Floor: wet concrete, darkened, with plate seams.
  const C = `${BASE}/ambientcg/Concrete034/Concrete034_1K-JPG_`
  const floorMat = track(
    new MeshStandardMaterial({
      map: tex(C + 'Color.jpg', true, 14, 5),
      normalMap: tex(C + 'NormalGL.jpg', false, 14, 5),
      roughnessMap: tex(C + 'Roughness.jpg', false, 14, 5),
      color: 0x6d625a,
      roughness: 0.55,
      metalness: 0.15,
      envMapIntensity: 0.9,
    }),
  )
  const floor = new Mesh(track(new PlaneGeometry(STAGE_HALF_UNITS * 2 + 12, 14)), floorMat)
  floor.rotation.x = -Math.PI / 2
  floor.position.z = -2
  floor.receiveShadow = true
  group.add(floor)

  // LC1: a seam is a faint groove, not a black stripe (tinderbox-r3 read the 5 cm near-black boxes as thick bars): thinner, the floor's own
  // shadow colour, translucent.
  const seamMat = track(new MeshBasicMaterial({ color: 0x1c1712, transparent: true, opacity: 0.35, depthWrite: false }))
  const seamGeo = track(new BoxGeometry(0.02, 0.004, 10))
  for (let x = -STAGE_HALF_UNITS - 4; x <= STAGE_HALF_UNITS + 4; x += 2.5) {
    const seam = new Mesh(seamGeo, seamMat)
    seam.position.set(x, 0.003, -2)
    group.add(seam)
  }

  // Back wall: rusted painted metal.
  const R = `${BASE}/polyhaven/rusty_painted_metal/rusty_painted_metal_`
  const wallMat = track(
    new MeshStandardMaterial({
      map: tex(R + 'diff_1k.jpg', true, 8, 2.2),
      normalMap: tex(R + 'nor_gl_1k.jpg', false, 8, 2.2),
      roughnessMap: tex(R + 'rough_1k.jpg', false, 8, 2.2),
      color: 0x8a7a70,
      metalness: 0.5,
      roughness: 1,
      envMapIntensity: 0.6,
    }),
  )
  const wall = new Mesh(track(new PlaneGeometry(STAGE_HALF_UNITS * 2 + 16, 9)), wallMat)
  wall.position.set(0, 4.5, -6)
  group.add(wall)

  // Gantry silhouettes: dark beams and columns in front of the wall.
  const darkMat = track(new MeshStandardMaterial({ color: 0x15130f, roughness: 0.8, metalness: 0.6 }))
  const beam = track(new BoxGeometry(STAGE_HALF_UNITS * 2 + 16, 0.28, 0.4))
  for (const [y, z] of [[5.4, -4.6], [3.6, -5.2]] as const) {
    const b = new Mesh(beam, darkMat)
    b.position.set(0, y, z)
    b.castShadow = true
    group.add(b)
  }
  const col = track(new BoxGeometry(0.4, 7.2, 0.4))
  for (let x = -14; x <= 14; x += 5.6) {
    const c = new Mesh(col, darkMat)
    c.position.set(x, 3.6, -4.8)
    c.castShadow = true
    group.add(c)
  }
  const brace = track(new BoxGeometry(0.12, 4, 0.12))
  for (let x = -12; x <= 12; x += 5.6) {
    const b = new Mesh(brace, darkMat)
    b.position.set(x + 2.8, 4.4, -4.9)
    b.rotation.z = 0.55
    group.add(b)
  }

  // Chain-link fence, a translucent diamond mesh between the fighters and the wall.
  const linkTex = track(chainLinkTexture())
  linkTex.magFilter = LinearFilter
  const fence = new Mesh(
    track(new PlaneGeometry(STAGE_HALF_UNITS * 2 + 12, 2.6)),
    track(new MeshBasicMaterial({ map: linkTex, transparent: true, opacity: 0.22, color: 0x9aa0a8, side: DoubleSide, depthWrite: false })),
  )
  fence.position.set(0, 1.3, -3.2)
  group.add(fence)

  // Furnace: a rusted iron body (PBR, the same CC0 metal as the wall) around a recessed mouth that glows
  // through an emissive map of coals and bars, with a key light that flickers.
  const ironMat = track(
    new MeshStandardMaterial({
      map: tex(R + 'diff_1k.jpg', true, 1.4, 1.4),
      normalMap: tex(R + 'nor_gl_1k.jpg', false, 1.4, 1.4),
      roughnessMap: tex(R + 'rough_1k.jpg', false, 1.4, 1.4),
      color: 0x6e5a4e,
      metalness: 0.75,
      roughness: 1,
      envMapIntensity: 0.7,
    }),
  )
  const body = new Mesh(track(new BoxGeometry(3.6, 3.4, 1.5)), ironMat)
  body.position.set(-7.5, 1.7, -5.55)
  body.castShadow = true
  group.add(body)
  const stack = new Mesh(track(new CylinderGeometry(0.34, 0.46, 4.2, 14)), ironMat)
  stack.position.set(-8.3, 5.3, -5.7)
  stack.castShadow = true
  group.add(stack)
  for (const [w, h, x, y] of [[2.6, 0.18, 0, 1.24], [2.6, 0.18, 0, 0.1], [0.18, 1.3, -1.3, 0.67], [0.18, 1.3, 1.3, 0.67]] as const) {
    const lip = new Mesh(track(new BoxGeometry(w, h, 0.3)), ironMat)
    lip.position.set(-7.5 + x, 0.55 + y, -4.72)
    group.add(lip)
  }
  const furnaceMat = track(
    new MeshStandardMaterial({ color: 0x1a0d08, roughness: 0.9, metalness: 0, emissive: 0xffffff, emissiveMap: track(coalTexture()), emissiveIntensity: 1.6, toneMapped: false }),
  )
  const mouth = new Mesh(track(new PlaneGeometry(2.4, 1.2)), furnaceMat)
  mouth.position.set(-7.5, 1.17, -4.78)
  group.add(mouth)
  const glow = new Mesh(
    track(new PlaneGeometry(7, 5)),
    track(new MeshBasicMaterial({ map: track(radialGlowTexture()), color: 0xff7a2a, transparent: true, opacity: 0.35, blending: AdditiveBlending, depthWrite: false, toneMapped: false })),
  )
  glow.position.set(-7.5, 1.4, -4.55)
  group.add(glow)

  const key = new SpotLight(0xffa35a, 520, 40, 0.75, 0.6, 1.6)
  key.position.set(-8, 4.5, -4.5)
  key.target.position.set(0, 1, 0)
  key.castShadow = opts.quality === 'high'
  key.shadow.mapSize.set(1024, 1024)
  key.shadow.bias = -0.0004
  key.shadow.radius = 4
  group.add(key, key.target)
  const furnaceLight = new PointLight(0xff7a2a, 16, 12, 1.8)
  furnaceLight.position.set(-7, 3, -4.5)
  group.add(furnaceLight)

  // Cold skylight fill from the right, about a third of the key.
  const fill = new DirectionalLight(0xb7d0ff, 0.55)
  fill.position.set(7, 6, 5)
  group.add(fill)
  const hemi = new HemisphereLight(0x6d7f99, 0x201510, 0.35)
  group.add(hemi)

  // Sparks: additive points drifting up and across from the furnace side.
  const N = opts.quality === 'high' ? 200 : 70
  const sparkPos = new Float32Array(N * 3)
  const sparkVel = new Float32Array(N * 3)
  const sparkLife = new Float32Array(N)
  const respawn = (i: number, warm: boolean): void => {
    sparkPos[i * 3] = -8 + Math.random() * 4
    sparkPos[i * 3 + 1] = 0.3 + Math.random() * 2
    sparkPos[i * 3 + 2] = -5 + Math.random() * 4
    sparkVel[i * 3] = 0.3 + Math.random() * 0.9
    sparkVel[i * 3 + 1] = 0.25 + Math.random() * 0.8
    sparkVel[i * 3 + 2] = (Math.random() - 0.5) * 0.3
    sparkLife[i] = warm ? Math.random() * 6 : 4 + Math.random() * 5
  }
  for (let i = 0; i < N; i++) respawn(i, true)
  const sparkGeo = track(new BufferGeometry())
  sparkGeo.setAttribute('position', new BufferAttribute(sparkPos, 3))
  const sparks = new Points(sparkGeo, track(new PointsMaterial({ color: 0xffa050, size: 0.06, transparent: true, opacity: 0.9, blending: AdditiveBlending, depthWrite: false, toneMapped: false })))
  sparks.frustumCulled = false
  group.add(sparks)

  scene.add(group)

  const ready = (async () => {
    await Promise.all(loading)
    const hdr = await new HDRLoader().loadAsync(`${BASE}/polyhaven/unfinished_office_night/unfinished_office_night_1k.hdr`)
    const pm = new PMREMGenerator(renderer)
    const env = pm.fromEquirectangular(hdr)
    scene.environment = env.texture
    scene.environmentIntensity = 0.35
    hdr.dispose()
    pm.dispose()
    disposables.push(env)
  })()

  let flick = 0
  return {
    group,
    ready,
    update(dt, t) {
      // Flicker: two incommensurate square-ish waves, no randomness so a capture is repeatable.
      flick = 0.85 + 0.1 * Math.sin(t * 7.3) + 0.05 * Math.sin(t * 17.9 + 1)
      key.intensity = 520 * flick
      furnaceLight.intensity = 16 * flick
      furnaceMat.emissiveIntensity = 1.9 * flick
      for (let i = 0; i < N; i++) {
        sparkLife[i]! <= 0 ? respawn(i, false) : (sparkLife[i] = sparkLife[i]! - dt)
        sparkPos[i * 3] = sparkPos[i * 3]! + sparkVel[i * 3]! * dt
        sparkPos[i * 3 + 1] = sparkPos[i * 3 + 1]! + sparkVel[i * 3 + 1]! * dt
        sparkPos[i * 3 + 2] = sparkPos[i * 3 + 2]! + sparkVel[i * 3 + 2]! * dt
      }
      sparkGeo.attributes.position!.needsUpdate = true
    },
    dispose() {
      scene.remove(group)
      for (const d of disposables) d.dispose()
    },
  }
}
