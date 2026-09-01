/**
 * Oriented-box overlap via the separating axis theorem.
 *
 * Cars collide with each other through their box hitboxes, same as they do
 * with the ball. Sphere approximations were tried first and are noticeably
 * wrong: a car is 118 x 84 x 36, so any single sphere either bumps at absurd
 * vertical range or lets noses pass through each other.
 */

import { M, V, type Mat3, type Vec3 } from '../core/math';

export interface Obb {
  center: Vec3;
  orientation: Mat3;
  halfExtents: Vec3;
}

export interface Overlap {
  /** Unit vector pointing from A to B along the axis of least penetration. */
  normal: Vec3;
  depth: number;
  /** Approximate world-space contact point. */
  point: Vec3;
}

function extentAlong(box: Obb, axis: Vec3): number {
  const local = M.mulTVec(box.orientation, axis);
  return (
    Math.abs(local.x) * box.halfExtents.x +
    Math.abs(local.y) * box.halfExtents.y +
    Math.abs(local.z) * box.halfExtents.z
  );
}

/** Closest point on `box` to the world point `p`. */
export function closestPointOnObb(p: Vec3, box: Obb): Vec3 {
  const local = M.mulTVec(box.orientation, V.sub(p, box.center));
  const h = box.halfExtents;
  const clamped = V.make(
    Math.max(-h.x, Math.min(h.x, local.x)),
    Math.max(-h.y, Math.min(h.y, local.y)),
    Math.max(-h.z, Math.min(h.z, local.z)),
  );
  return V.add(box.center, M.mulVec(box.orientation, clamped));
}

export function obbOverlap(a: Obb, b: Obb): Overlap | null {
  const delta = V.sub(b.center, a.center);

  const axes: Vec3[] = [];
  for (let i = 0; i < 3; i++) axes.push(M.col(a.orientation, i));
  for (let i = 0; i < 3; i++) axes.push(M.col(b.orientation, i));
  for (let i = 0; i < 3; i++) {
    for (let j = 0; j < 3; j++) {
      const c = V.cross(M.col(a.orientation, i), M.col(b.orientation, j));
      // Near-parallel edge pairs give a degenerate axis; the face axes already
      // cover those cases, so skipping them is safe.
      if (V.lengthSq(c) > 1e-8) axes.push(V.normalize(c));
    }
  }

  let bestDepth = Infinity;
  let bestAxis: Vec3 | null = null;

  for (const axis of axes) {
    const separation = Math.abs(V.dot(delta, axis));
    const overlap = extentAlong(a, axis) + extentAlong(b, axis) - separation;
    if (overlap <= 0) return null; // found a separating axis
    if (overlap < bestDepth) {
      bestDepth = overlap;
      bestAxis = V.dot(delta, axis) < 0 ? V.neg(axis) : axis;
    }
  }

  if (!bestAxis) return null;
  return {
    normal: bestAxis,
    depth: bestDepth,
    point: V.lerp(closestPointOnObb(b.center, a), closestPointOnObb(a.center, b), 0.5),
  };
}
