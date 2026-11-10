// exp(x) from + - * / floor round only, so the agent's softmax gives the same bits in Bun and in every phone
// browser (Math.exp is not specified to round the same way across engines). Range reduction x = k ln2 + r with
// |r| <= ln2 / 2, a degree 13 Taylor series for e^r (error under 1e-16), then the exact scaling by 2^k.
const LN2 = 0.6931471805599453
const INV_LN2 = 1.4426950408889634

export function detExp(x: number): number {
  if (x < -745) return 0
  const k = Math.round(x * INV_LN2)
  const r = x - k * LN2
  let term = 1
  let sum = 1
  for (let n = 1; n <= 13; n++) {
    term = (term * r) / n
    sum += term
  }
  // Multiplying or dividing by 2 is exact, so the scaling adds no rounding.
  let out = sum
  for (let i = 0; i < k; i++) out *= 2
  for (let i = 0; i > k; i--) out /= 2
  return out
}
