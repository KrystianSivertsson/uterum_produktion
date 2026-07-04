export type Vec3 = readonly [number, number, number];

export function add(a: Vec3, b: Vec3): Vec3 {
  return [a[0] + b[0], a[1] + b[1], a[2] + b[2]];
}

export function sub(a: Vec3, b: Vec3): Vec3 {
  return [a[0] - b[0], a[1] - b[1], a[2] - b[2]];
}

export function scale(a: Vec3, s: number): Vec3 {
  return [a[0] * s, a[1] * s, a[2] * s];
}

export function dot(a: Vec3, b: Vec3): number {
  return a[0] * b[0] + a[1] * b[1] + a[2] * b[2];
}

export function cross(a: Vec3, b: Vec3): Vec3 {
  return [a[1] * b[2] - a[2] * b[1], a[2] * b[0] - a[0] * b[2], a[0] * b[1] - a[1] * b[0]];
}

export function norm(a: Vec3): number {
  return Math.hypot(a[0], a[1], a[2]);
}

export function normalize(a: Vec3): Vec3 {
  const n = norm(a);
  if (n === 0) throw new Error("Kan inte normalisera nollvektor");
  return scale(a, 1 / n);
}

/** Kanonisk riktning: n och -n mappas till samma vektor (för klustring). */
export function canonical(a: Vec3): Vec3 {
  for (const component of a) {
    if (Math.abs(component) > 1e-9) return component < 0 ? scale(a, -1) : a;
  }
  return a;
}

export function roundTo(value: number, decimals: number): number {
  const factor = 10 ** decimals;
  const result = Math.round(value * factor) / factor;
  return result === 0 ? 0 : result; // normalisera -0
}
