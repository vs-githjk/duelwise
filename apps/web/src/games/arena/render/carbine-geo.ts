import { BufferGeometry, CylinderGeometry, ExtrudeGeometry, Shape } from 'three'
import { mergeGeometries } from 'three/examples/jsm/utils/BufferGeometryUtils.js'

// The Carbine's procedural body, in gun space (metres): the barrel axis is y 0, the muzzle runs along -z, the pistol grip is near z 0.
// Every part is a 2D side profile (u forward, y up) extruded across the gun with a small bevel, or a cylinder along the barrel axis.
// The parts merge into three geometries (anodized metal, polymer furniture, optic glass) so the whole gun is three draw calls.

type P = [number, number]

/** A side profile extruded `width` across the gun, centred on x, with u mapped to -z. */
function profile(points: P[], width: number, bevel = 0.003, x = 0, curve?: (s: Shape) => void): BufferGeometry {
  const s = new Shape()
  if (curve) curve(s)
  else {
    s.moveTo(points[0]![0], points[0]![1])
    for (const p of points.slice(1)) s.lineTo(p[0], p[1])
    s.closePath()
  }
  const geo = new ExtrudeGeometry(s, { depth: width - bevel * 2, bevelEnabled: true, bevelThickness: bevel, bevelSize: bevel, bevelSegments: 2, curveSegments: 10 })
  geo.translate(0, 0, -(width - bevel * 2) / 2)
  geo.rotateY(Math.PI / 2) // shape x (forward) -> -z, extrusion -> x
  geo.translate(x, 0, 0)
  return geo
}

/** A cylinder along the barrel axis from z0 to z1 (z1 < z0 is forward). */
function tube(r0: number, r1: number, z0: number, z1: number, y = 0, x = 0, seg = 16): BufferGeometry {
  const geo = new CylinderGeometry(r1, r0, Math.abs(z0 - z1), seg, 1)
  geo.rotateX(-Math.PI / 2) // cylinder y axis -> -z, r1 (top) at the front
  geo.translate(x, y, (z0 + z1) / 2)
  return geo
}

function slab(w: number, h: number, l: number, x: number, y: number, z: number): BufferGeometry {
  return profile([[-l / 2, -h / 2], [l / 2, -h / 2], [l / 2, h / 2], [-l / 2, h / 2]], w, Math.min(w, h, l) * 0.12, x).translate(0, y, z)
}

export interface CarbineGeometry {
  metal: BufferGeometry
  polymer: BufferGeometry
  glass: BufferGeometry
}

const flat = (g: BufferGeometry): BufferGeometry => {
  const n = g.index ? g.toNonIndexed() : g
  for (const k of Object.keys(n.attributes)) if (k !== 'position' && k !== 'normal' && k !== 'uv') n.deleteAttribute(k)
  return n
}

export function buildCarbineGeometry(muzzleZ: number): CarbineGeometry {
  const metal: BufferGeometry[] = []
  const polymer: BufferGeometry[] = []
  const glass: BufferGeometry[] = []
  const barrelEnd = muzzleZ // negative: the front of the barrel
  // Upper receiver with a raised ejection step, and the lower receiver with the magwell and trigger guard.
  metal.push(profile([[-0.03, -0.028], [0.31, -0.028], [0.31, 0.034], [0.22, 0.034], [0.2, 0.04], [0.02, 0.04], [-0.03, 0.03]], 0.05, 0.004))
  metal.push(profile([[0.0, -0.03], [0.3, -0.03], [0.3, -0.062], [0.215, -0.062], [0.215, -0.075], [0.135, -0.075], [0.135, -0.062], [0.075, -0.062], [0.075, -0.04], [0.0, -0.04]], 0.046, 0.004))
  // Picatinny rail: a strip with teeth along the top of the receiver.
  for (let i = 0; i < 9; i++) metal.push(slab(0.032, 0.008, 0.016, 0, 0.044, -0.015 - i * 0.03))
  metal.push(slab(0.024, 0.006, 0.28, 0, 0.04, -0.14))
  // Charging handle and ejection port cover.
  metal.push(slab(0.014, 0.016, 0.03, 0, 0.034, 0.03))
  metal.push(slab(0.006, 0.026, 0.075, 0.026, 0.01, -0.14))
  // Barrel, gas block and the sight post base.
  metal.push(tube(0.0115, 0.0115, -0.3, barrelEnd + 0.01, 0, 0, 14))
  metal.push(tube(0.017, 0.017, -0.5, -0.53, 0, 0, 14))
  // Handguard with vents: a polymer tube, dark slots in rows on each side and below.
  polymer.push(tube(0.031, 0.029, -0.29, -0.52, 0, 0, 18))
  for (let i = 0; i < 5; i++) {
    const z = -0.325 - i * 0.04
    for (const x of [-0.0285, 0.0285]) polymer.push(slab(0.006, 0.02, 0.022, x, 0.0, z))
    polymer.push(slab(0.02, 0.006, 0.022, 0, -0.0285, z))
  }
  // Pistol grip (raked), trigger guard bar and trigger, and a stock with a cheek step.
  polymer.push(profile([[0.07, -0.038], [0.0, -0.038], [-0.05, -0.19], [0.015, -0.2], [0.075, -0.08]], 0.036, 0.004))
  polymer.push(profile([[0.1, -0.058], [0.2, -0.058], [0.2, -0.066], [0.1, -0.066]], 0.006, 0.001))
  polymer.push(slab(0.006, 0.03, 0.01, 0, -0.05, -0.115))
  polymer.push(profile([[-0.01, 0.034], [-0.17, 0.036], [-0.2, 0.03], [-0.21, -0.01], [-0.2, -0.085], [-0.17, -0.09], [-0.12, -0.045], [-0.01, -0.03]], 0.044, 0.005))
  polymer.push(profile([[-0.2, 0.03], [-0.215, 0.03], [-0.215, -0.085], [-0.2, -0.085]], 0.048, 0.003)) // butt pad
  // The curved magazine: a banana profile extruded across the gun.
  polymer.push(
    profile([], 0.04, 0.004, 0, (s) => {
      s.moveTo(0.135, -0.062)
      s.lineTo(0.215, -0.062)
      s.quadraticCurveTo(0.225, -0.15, 0.265, -0.205)
      s.lineTo(0.2, -0.218)
      s.quadraticCurveTo(0.15, -0.15, 0.135, -0.062)
    }),
  )
  // The optic: two mounts, a tube with a flared hood and a dark lens, kept below the old optic's height.
  metal.push(slab(0.026, 0.02, 0.014, 0, 0.056, -0.04), slab(0.026, 0.02, 0.014, 0, 0.056, -0.15))
  metal.push(tube(0.02, 0.02, -0.02, -0.17, 0.077, 0, 18))
  metal.push(tube(0.024, 0.024, -0.17, -0.2, 0.077, 0, 18))
  glass.push(tube(0.0215, 0.0215, -0.2005, -0.2015, 0.077, 0, 18))
  glass.push(tube(0.0175, 0.0175, -0.0195, -0.0185, 0.077, 0, 18))
  const gather = (list: BufferGeometry[]): BufferGeometry => {
    const merged = mergeGeometries(list.map(flat))!
    list.forEach((g) => g.dispose())
    return merged
  }
  return { metal: gather(metal), polymer: gather(polymer), glass: gather(glass) }
}
