/**
 * Minimal 3D math for the physics core.
 *
 * Deliberately independent of Three.js: the simulation runs in a Z-up frame
 * (matching every published constant in DESIGN.md) while the renderer is Y-up.
 * Keeping the two apart means the physics code can be read side-by-side with
 * the reference material without a mental axis swap, and lets the whole
 * simulation be unit-tested without a WebGL context.
 *
 * Vectors are plain `{x, y, z}` records and every operation returns a new one.
 * Rotations are 3x3 matrices stored row-major in a `Float64Array(9)`, with the
 * *columns* holding the body's local axes in world space:
 *
 *   column 0 = forward, column 1 = left, column 2 = up
 *
 * so `mulVec(o, local)` maps body -> world and `mulTVec(o, world)` maps
 * world -> body.
 */

export interface Vec3 {
  x: number;
  y: number;
  z: number;
}

export type Mat3 = Float64Array;

export const V = {
  make(x = 0, y = 0, z = 0): Vec3 {
    return { x, y, z };
  },

  zero(): Vec3 {
    return { x: 0, y: 0, z: 0 };
  },

  clone(a: Vec3): Vec3 {
    return { x: a.x, y: a.y, z: a.z };
  },

  add(a: Vec3, b: Vec3): Vec3 {
    return { x: a.x + b.x, y: a.y + b.y, z: a.z + b.z };
  },

  sub(a: Vec3, b: Vec3): Vec3 {
    return { x: a.x - b.x, y: a.y - b.y, z: a.z - b.z };
  },

  scale(a: Vec3, s: number): Vec3 {
    return { x: a.x * s, y: a.y * s, z: a.z * s };
  },

  /** a + b * s -- the workhorse of every integrator step. */
  addScaled(a: Vec3, b: Vec3, s: number): Vec3 {
    return { x: a.x + b.x * s, y: a.y + b.y * s, z: a.z + b.z * s };
  },

  mulComponents(a: Vec3, b: Vec3): Vec3 {
    return { x: a.x * b.x, y: a.y * b.y, z: a.z * b.z };
  },

  neg(a: Vec3): Vec3 {
    return { x: -a.x, y: -a.y, z: -a.z };
  },

  dot(a: Vec3, b: Vec3): number {
    return a.x * b.x + a.y * b.y + a.z * b.z;
  },

  cross(a: Vec3, b: Vec3): Vec3 {
    return {
      x: a.y * b.z - a.z * b.y,
      y: a.z * b.x - a.x * b.z,
      z: a.x * b.y - a.y * b.x,
    };
  },

  lengthSq(a: Vec3): number {
    return a.x * a.x + a.y * a.y + a.z * a.z;
  },

  length(a: Vec3): number {
    return Math.hypot(a.x, a.y, a.z);
  },

  distance(a: Vec3, b: Vec3): number {
    return Math.hypot(a.x - b.x, a.y - b.y, a.z - b.z);
  },

  normalize(a: Vec3): Vec3 {
    const len = Math.hypot(a.x, a.y, a.z);
    if (len < 1e-9) return { x: 0, y: 0, z: 0 };
    return { x: a.x / len, y: a.y / len, z: a.z / len };
  },

  /** Rescale `a` to at most `max` length, leaving shorter vectors untouched. */
  clampLength(a: Vec3, max: number): Vec3 {
    const len = Math.hypot(a.x, a.y, a.z);
    if (len <= max || len < 1e-9) return { x: a.x, y: a.y, z: a.z };
    const s = max / len;
    return { x: a.x * s, y: a.y * s, z: a.z * s };
  },

  lerp(a: Vec3, b: Vec3, t: number): Vec3 {
    return {
      x: a.x + (b.x - a.x) * t,
      y: a.y + (b.y - a.y) * t,
      z: a.z + (b.z - a.z) * t,
    };
  },

  /** Component of `a` along `n` (n assumed unit). */
  project(a: Vec3, n: Vec3): Vec3 {
    const d = V.dot(a, n);
    return { x: n.x * d, y: n.y * d, z: n.z * d };
  },

  /** Component of `a` perpendicular to `n` (n assumed unit). */
  reject(a: Vec3, n: Vec3): Vec3 {
    const d = V.dot(a, n);
    return { x: a.x - n.x * d, y: a.y - n.y * d, z: a.z - n.z * d };
  },

  isFinite(a: Vec3): boolean {
    return Number.isFinite(a.x) && Number.isFinite(a.y) && Number.isFinite(a.z);
  },
};

export const M = {
  identity(): Mat3 {
    const m = new Float64Array(9);
    m[0] = 1;
    m[4] = 1;
    m[8] = 1;
    return m;
  },

  clone(a: Mat3): Mat3 {
    return new Float64Array(a) as Mat3;
  },

  /** Column `c` of `m`, i.e. one of the body's local axes in world space. */
  col(m: Mat3, c: number): Vec3 {
    return { x: m[c], y: m[3 + c], z: m[6 + c] };
  },

  setCol(m: Mat3, c: number, v: Vec3): void {
    m[c] = v.x;
    m[3 + c] = v.y;
    m[6 + c] = v.z;
  },

  /** Body -> world. */
  mulVec(m: Mat3, v: Vec3): Vec3 {
    return {
      x: m[0] * v.x + m[1] * v.y + m[2] * v.z,
      y: m[3] * v.x + m[4] * v.y + m[5] * v.z,
      z: m[6] * v.x + m[7] * v.y + m[8] * v.z,
    };
  },

  /** World -> body (multiply by the transpose; valid because `m` is orthonormal). */
  mulTVec(m: Mat3, v: Vec3): Vec3 {
    return {
      x: m[0] * v.x + m[3] * v.y + m[6] * v.z,
      y: m[1] * v.x + m[4] * v.y + m[7] * v.z,
      z: m[2] * v.x + m[5] * v.y + m[8] * v.z,
    };
  },

  mul(a: Mat3, b: Mat3): Mat3 {
    const out = new Float64Array(9);
    for (let r = 0; r < 3; r++) {
      for (let c = 0; c < 3; c++) {
        out[r * 3 + c] =
          a[r * 3] * b[c] + a[r * 3 + 1] * b[3 + c] + a[r * 3 + 2] * b[6 + c];
      }
    }
    return out;
  },

  transpose(a: Mat3): Mat3 {
    const out = new Float64Array(9);
    for (let r = 0; r < 3; r++) for (let c = 0; c < 3; c++) out[r * 3 + c] = a[c * 3 + r];
    return out;
  },

  /**
   * Rodrigues rotation about `axis` by `|axis|` radians. Used to integrate
   * angular velocity: `o = axisToRotation(w * dt) * o`.
   */
  axisToRotation(axis: Vec3): Mat3 {
    const theta = V.length(axis);
    const out = M.identity();
    if (theta < 1e-12) return out;

    const k = V.scale(axis, 1 / theta);
    const s = Math.sin(theta);
    const c = Math.cos(theta);
    const t = 1 - c;

    out[0] = t * k.x * k.x + c;
    out[1] = t * k.x * k.y - s * k.z;
    out[2] = t * k.x * k.z + s * k.y;
    out[3] = t * k.x * k.y + s * k.z;
    out[4] = t * k.y * k.y + c;
    out[5] = t * k.y * k.z - s * k.x;
    out[6] = t * k.x * k.z - s * k.y;
    out[7] = t * k.y * k.z + s * k.x;
    out[8] = t * k.z * k.z + c;
    return out;
  },

  /**
   * Build a rotation from a forward and an up hint. `forward` becomes column 0,
   * `left` column 1, `up` column 2 -- matching the body-axis convention above.
   */
  fromForwardUp(forward: Vec3, up: Vec3): Mat3 {
    const f = V.normalize(forward);
    let u = V.normalize(V.reject(up, f));
    if (V.lengthSq(u) < 1e-12) {
      // Forward is parallel to the up hint; pick any perpendicular.
      const alt = Math.abs(f.z) < 0.9 ? V.make(0, 0, 1) : V.make(1, 0, 0);
      u = V.normalize(V.reject(alt, f));
    }
    const l = V.cross(u, f); // left = up x forward, giving a right-handed basis
    const m = M.identity();
    M.setCol(m, 0, f);
    M.setCol(m, 1, l);
    M.setCol(m, 2, u);
    return m;
  },

  /** Rotation about world Z (yaw). */
  fromYaw(yaw: number): Mat3 {
    return M.fromForwardUp(V.make(Math.cos(yaw), Math.sin(yaw), 0), V.make(0, 0, 1));
  },

  /**
   * Gram-Schmidt re-orthonormalisation. Integrating angular velocity with
   * Rodrigues drifts by ~1e-15 per tick; at 120 Hz for a 5 minute match that
   * accumulates, so we renormalise every step. Cheap insurance.
   */
  orthonormalize(m: Mat3): Mat3 {
    const f = V.normalize(M.col(m, 0));
    const u = V.normalize(V.reject(M.col(m, 2), f));
    return M.fromForwardUp(f, u);
  },

  /** Euler angles in the reference game's (pitch, yaw, roll) convention. */
  toEuler(m: Mat3): { pitch: number; yaw: number; roll: number } {
    const f = M.col(m, 0);
    const l = M.col(m, 1);
    const u = M.col(m, 2);
    return {
      pitch: Math.asin(clamp(f.z, -1, 1)),
      yaw: Math.atan2(f.y, f.x),
      roll: Math.atan2(-l.z, u.z),
    };
  },

  /** Antisymmetric ("cross product") matrix of `v`, i.e. `antisym(v) * a = v x a`. */
  antisym(v: Vec3): Mat3 {
    const m = new Float64Array(9);
    m[0] = 0;
    m[1] = -v.z;
    m[2] = v.y;
    m[3] = v.z;
    m[4] = 0;
    m[5] = -v.x;
    m[6] = -v.y;
    m[7] = v.x;
    m[8] = 0;
    return m;
  },

  scaleMat(a: Mat3, s: number): Mat3 {
    const out = new Float64Array(9);
    for (let i = 0; i < 9; i++) out[i] = a[i] * s;
    return out;
  },

  sub(a: Mat3, b: Mat3): Mat3 {
    const out = new Float64Array(9);
    for (let i = 0; i < 9; i++) out[i] = a[i] - b[i];
    return out;
  },

  add(a: Mat3, b: Mat3): Mat3 {
    const out = new Float64Array(9);
    for (let i = 0; i < 9; i++) out[i] = a[i] + b[i];
    return out;
  },

  diagonal(x: number, y: number, z: number): Mat3 {
    const m = new Float64Array(9);
    m[0] = x;
    m[4] = y;
    m[8] = z;
    return m;
  },

  /** General 3x3 inverse via the adjugate. Returns identity for singular input. */
  invert(a: Mat3): Mat3 {
    const c00 = a[4] * a[8] - a[5] * a[7];
    const c01 = a[5] * a[6] - a[3] * a[8];
    const c02 = a[3] * a[7] - a[4] * a[6];
    const det = a[0] * c00 + a[1] * c01 + a[2] * c02;
    if (Math.abs(det) < 1e-12) return M.identity();
    const inv = 1 / det;
    const out = new Float64Array(9);
    out[0] = c00 * inv;
    out[1] = (a[2] * a[7] - a[1] * a[8]) * inv;
    out[2] = (a[1] * a[5] - a[2] * a[4]) * inv;
    out[3] = c01 * inv;
    out[4] = (a[0] * a[8] - a[2] * a[6]) * inv;
    out[5] = (a[2] * a[3] - a[0] * a[5]) * inv;
    out[6] = c02 * inv;
    out[7] = (a[1] * a[6] - a[0] * a[7]) * inv;
    out[8] = (a[0] * a[4] - a[1] * a[3]) * inv;
    return out;
  },
};

export function clamp(v: number, lo: number, hi: number): number {
  return v < lo ? lo : v > hi ? hi : v;
}

export function lerp(a: number, b: number, t: number): number {
  return a + (b - a) * t;
}

export function sign(v: number): number {
  return v > 0 ? 1 : v < 0 ? -1 : 0;
}

/**
 * Frame-rate independent exponential approach. `rate` is roughly "how many
 * e-foldings per second", so higher = snappier. Used for every smoothed value
 * in the camera and audio so behaviour is identical at 60 and 144 Hz.
 */
export function damp(current: number, target: number, rate: number, dt: number): number {
  return target + (current - target) * Math.exp(-rate * dt);
}

export function dampVec(current: Vec3, target: Vec3, rate: number, dt: number): Vec3 {
  const k = Math.exp(-rate * dt);
  return {
    x: target.x + (current.x - target.x) * k,
    y: target.y + (current.y - target.y) * k,
    z: target.z + (current.z - target.z) * k,
  };
}

/** Shortest signed difference between two angles, in (-pi, pi]. */
export function angleDelta(from: number, to: number): number {
  let d = (to - from) % (Math.PI * 2);
  if (d > Math.PI) d -= Math.PI * 2;
  if (d <= -Math.PI) d += Math.PI * 2;
  return d;
}

/** Deterministic PRNG (mulberry32) -- keeps replays and tests reproducible. */
export function makeRandom(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}
