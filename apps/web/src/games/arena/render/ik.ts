import { Quaternion, Vector3, type Object3D } from 'three'

// Two bone inverse kinematics for an arm: bends `upper` and `lower` so `end` (the hand) reaches
// `target`, with the elbow pushed toward `pole`. Used to aim the opponent's gun, because the pistol
// clips of the animation library hold the gun low and the shooter needs it pointed at you.

const A = new Vector3()
const B = new Vector3()
const C = new Vector3()
const AT = new Vector3()
const P = new Vector3()
const NB = new Vector3()
const from = new Vector3()
const to = new Vector3()
const qa = new Quaternion()
const qp = new Quaternion()
const wq = new Quaternion()

/** Rotates `bone` in world space by the shortest rotation taking `from` onto `to` (both directions). */
function swing(bone: Object3D, f: Vector3, t: Vector3): void {
  qa.setFromUnitVectors(f.clone().normalize(), t.clone().normalize())
  bone.getWorldQuaternion(wq)
  wq.premultiply(qa)
  if (bone.parent) {
    bone.parent.getWorldQuaternion(qp)
    wq.premultiply(qp.invert())
  }
  bone.quaternion.copy(wq)
  bone.updateMatrixWorld(true)
}

export interface IkResult {
  /** False when the target was out of reach and the arm was stretched toward it. */
  reached: boolean
}

export function twoBoneIK(upper: Object3D, lower: Object3D, end: Object3D, target: Vector3, pole: Vector3): IkResult {
  upper.updateWorldMatrix(true, true)
  upper.getWorldPosition(A)
  lower.getWorldPosition(B)
  end.getWorldPosition(C)
  const l1 = A.distanceTo(B)
  const l2 = B.distanceTo(C)
  AT.copy(target).sub(A)
  const dRaw = AT.length()
  if (dRaw < 1e-6 || l1 < 1e-6 || l2 < 1e-6) return { reached: false }
  AT.divideScalar(dRaw)
  const lo = Math.abs(l1 - l2) + 1e-4
  const hi = l1 + l2 - 1e-4
  const d = Math.min(hi, Math.max(lo, dRaw))
  // Elbow: along the shoulder-target axis by a, off it by h toward the pole.
  const a = (l1 * l1 - l2 * l2 + d * d) / (2 * d)
  const h = Math.sqrt(Math.max(0, l1 * l1 - a * a))
  P.copy(pole).sub(A)
  P.addScaledVector(AT, -P.dot(AT))
  if (P.lengthSq() < 1e-8) P.set(0, -1, 0).addScaledVector(AT, AT.y)
  P.normalize()
  NB.copy(A).addScaledVector(AT, a).addScaledVector(P, h)
  // Swing the upper bone so the elbow lands on NB, then the lower bone so the hand points at the target.
  from.copy(B).sub(A)
  to.copy(NB).sub(A)
  swing(upper, from, to)
  lower.getWorldPosition(B)
  end.getWorldPosition(C)
  from.copy(C).sub(B)
  to.copy(AT).multiplyScalar(d).add(A).sub(B)
  swing(lower, from, to)
  return { reached: dRaw <= hi && dRaw >= lo }
}
