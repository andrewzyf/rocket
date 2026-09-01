/**
 * Arena collision geometry.
 *
 * The playfield interior is a *convex* region: the intersection of ten
 * half-spaces (floor, ceiling, two side walls, two back walls, four 45-degree
 * corner walls), with every plane-plane junction rounded by a cylindrical
 * fillet and every plane-plane-plane junction by a spherical one. There are no
 * sharp interior corners anywhere, which is what lets a car drive continuously
 * from floor to wall to ceiling.
 *
 * Because it is convex and analytic we can compute exact contact points and
 * normals in closed form -- no triangle mesh, no broadphase, no solver. See
 * DESIGN.md section 9 and section 12 for why this replaces a physics engine
 * rather than sitting on top of one.
 *
 * Convention: a plane is `{ n, d }` with `n` the OUTWARD normal, and the
 * interior satisfying `dot(n, p) <= d`. Queries return INWARD normals, since
 * that is what collision response wants.
 */

import { M, V, type Vec3 } from '../core/math';
import {
  BACK_NET_Y,
  BACK_WALL_Y,
  CEILING_Z,
  CORNER_PLANE_OFFSET,
  FILLET_RADIUS,
  GOAL_CENTER_TO_POST,
  GOAL_HEIGHT,
  SIDE_WALL_X,
} from '../core/constants';

export interface Plane {
  /** Outward unit normal. */
  n: Vec3;
  /** Interior is `dot(n, p) <= d`. */
  d: number;
  /** Fillet radius used where this plane meets another. */
  r: number;
  /** Identifies the plane so callers can special-case (e.g. the goal mouth). */
  tag: string;
}

/** Result of a nearest-surface query from a point inside the arena. */
export interface SurfaceQuery {
  /** Distance from the query point to the boundary; negative if outside. */
  dist: number;
  /** Unit normal pointing back into the playable volume. */
  normal: Vec3;
}

export interface Contact {
  /** Point on the arena surface. */
  point: Vec3;
  /** Unit normal pointing into the playable volume. */
  normal: Vec3;
  /** How far the sphere has penetrated the surface (positive). */
  depth: number;
}

const SQRT1_2 = Math.SQRT1_2;

/** Cylindrical fillet where two planes meet: axis line + radius. */
interface EdgeFillet {
  a: number; // plane index
  b: number;
  origin: Vec3; // a point on the axis
  dir: Vec3; // unit direction of the axis
  r: number;
}

/** Spherical fillet where three planes meet. */
interface CornerFillet {
  a: number;
  b: number;
  c: number;
  center: Vec3;
  r: number;
}

function makePlane(n: Vec3, d: number, tag: string, r = FILLET_RADIUS): Plane {
  return { n: V.normalize(n), d, r, tag };
}

/**
 * The ten main arena planes. Corner planes use `|x| + |y| <= 8064`, normalised
 * to a unit normal.
 */
function buildArenaPlanes(): Plane[] {
  const planes: Plane[] = [
    makePlane(V.make(0, 0, -1), 0, 'floor'),
    makePlane(V.make(0, 0, 1), CEILING_Z, 'ceiling'),
    makePlane(V.make(-1, 0, 0), SIDE_WALL_X, 'wall-x-'),
    makePlane(V.make(1, 0, 0), SIDE_WALL_X, 'wall-x+'),
    makePlane(V.make(0, -1, 0), BACK_WALL_Y, 'wall-y-'),
    makePlane(V.make(0, 1, 0), BACK_WALL_Y, 'wall-y+'),
  ];
  for (const sx of [-1, 1]) {
    for (const sy of [-1, 1]) {
      planes.push(
        makePlane(
          V.make(sx * SQRT1_2, sy * SQRT1_2, 0),
          CORNER_PLANE_OFFSET * SQRT1_2,
          `corner-${sx > 0 ? 'x+' : 'x-'}${sy > 0 ? 'y+' : 'y-'}`,
        ),
      );
    }
  }
  return planes;
}

/** Goal recess: a box behind each goal mouth. Small fillets -- it is a net, not a ramp. */
function buildGoalPlanes(side: -1 | 1): Plane[] {
  const r = 32;
  return [
    makePlane(V.make(0, 0, -1), 0, 'goal-floor', r),
    makePlane(V.make(0, 0, 1), GOAL_HEIGHT, 'goal-roof', r),
    makePlane(V.make(-1, 0, 0), GOAL_CENTER_TO_POST, 'goal-x-', r),
    makePlane(V.make(1, 0, 0), GOAL_CENTER_TO_POST, 'goal-x+', r),
    makePlane(V.make(0, side, 0), BACK_NET_Y, 'goal-back', r),
  ];
}

/**
 * Intersection line of two inset planes (each pulled inward by its radius).
 * Returns null when the planes are parallel.
 */
function edgeAxis(p1: Plane, p2: Plane, r: number): { origin: Vec3; dir: Vec3 } | null {
  const dir = V.cross(p1.n, p2.n);
  const len = V.length(dir);
  if (len < 1e-6) return null;

  const a = p1.d - r;
  const b = p2.d - r;
  const c12 = V.dot(p1.n, p2.n);
  const denom = 1 - c12 * c12;
  if (Math.abs(denom) < 1e-9) return null;

  const k1 = (a - b * c12) / denom;
  const k2 = (b - a * c12) / denom;
  return {
    origin: V.add(V.scale(p1.n, k1), V.scale(p2.n, k2)),
    dir: V.scale(dir, 1 / len),
  };
}

/** Intersection point of three inset planes, or null if degenerate. */
function cornerPoint(p1: Plane, p2: Plane, p3: Plane, r: number): Vec3 | null {
  const m = new Float64Array(9);
  m[0] = p1.n.x;
  m[1] = p1.n.y;
  m[2] = p1.n.z;
  m[3] = p2.n.x;
  m[4] = p2.n.y;
  m[5] = p2.n.z;
  m[6] = p3.n.x;
  m[7] = p3.n.y;
  m[8] = p3.n.z;

  const det =
    m[0] * (m[4] * m[8] - m[5] * m[7]) -
    m[1] * (m[3] * m[8] - m[5] * m[6]) +
    m[2] * (m[3] * m[7] - m[4] * m[6]);
  if (Math.abs(det) < 1e-6) return null;

  const inv = M.invert(m as unknown as Float64Array);
  return M.mulVec(inv, V.make(p1.d - r, p2.d - r, p3.d - r));
}

/**
 * A convex cell: a set of planes plus the precomputed fillets between every
 * pair and triple that actually meet.
 */
class ConvexCell {
  readonly planes: Plane[];
  private readonly edges: EdgeFillet[] = [];
  private readonly corners: CornerFillet[] = [];

  constructor(planes: Plane[]) {
    this.planes = planes;
    const n = planes.length;

    for (let i = 0; i < n; i++) {
      for (let j = i + 1; j < n; j++) {
        const r = Math.min(planes[i].r, planes[j].r);
        const axis = edgeAxis(planes[i], planes[j], r);
        if (!axis) continue;
        // Only keep edges whose axis actually lies inside the cell; parallel or
        // never-meeting plane pairs (floor/ceiling, the two side walls) drop out.
        if (!this.axisIsReachable(axis.origin, axis.dir, i, j, r)) continue;
        this.edges.push({ a: i, b: j, origin: axis.origin, dir: axis.dir, r });
      }
    }

    for (let i = 0; i < n; i++) {
      for (let j = i + 1; j < n; j++) {
        for (let k = j + 1; k < n; k++) {
          const r = Math.min(planes[i].r, planes[j].r, planes[k].r);
          const c = cornerPoint(planes[i], planes[j], planes[k], r);
          if (!c) continue;
          if (!this.pointSatisfiesOthers(c, [i, j, k], r)) continue;
          this.corners.push({ a: i, b: j, c: k, center: c, r });
        }
      }
    }
  }

  /** True if some point on the axis line is inside every other inset plane. */
  private axisIsReachable(origin: Vec3, dir: Vec3, i: number, j: number, r: number): boolean {
    // Clip the line against the remaining inset planes; if any interval survives
    // the edge is real. A coarse sample is enough for an arena this simple.
    let lo = -1e6;
    let hi = 1e6;
    for (let k = 0; k < this.planes.length; k++) {
      if (k === i || k === j) continue;
      const p = this.planes[k];
      const denom = V.dot(p.n, dir);
      const slack = p.d - r - V.dot(p.n, origin);
      if (Math.abs(denom) < 1e-9) {
        if (slack < 0) return false;
        continue;
      }
      const t = slack / denom;
      if (denom > 0) hi = Math.min(hi, t);
      else lo = Math.max(lo, t);
    }
    return hi - lo > 1e-3;
  }

  private pointSatisfiesOthers(p: Vec3, skip: number[], r: number): boolean {
    for (let k = 0; k < this.planes.length; k++) {
      if (skip.includes(k)) continue;
      if (V.dot(this.planes[k].n, p) > this.planes[k].d - r + 1e-3) return false;
    }
    return true;
  }

  /**
   * Nearest boundary from `p`. Positive `dist` means inside.
   *
   * A point within `r` of two planes belongs to their cylindrical fillet; within
   * `r` of three, to their spherical one. Everywhere else the nearest flat plane
   * wins. `disabled` lets the caller switch off a plane -- used for the goal
   * mouth, where the back wall has a hole in it.
   */
  query(p: Vec3, disabled?: (tag: string) => boolean): SurfaceQuery {
    // Which inset planes does this point violate? That tells us which feature
    // (face, edge fillet, corner fillet) owns the nearest point.
    const violated: number[] = [];
    let best = Infinity;
    let bestIdx = -1;

    for (let i = 0; i < this.planes.length; i++) {
      const pl = this.planes[i];
      if (disabled?.(pl.tag)) continue;
      const signed = pl.d - V.dot(pl.n, p); // > 0 inside
      if (signed < best) {
        best = signed;
        bestIdx = i;
      }
      if (signed < pl.r) violated.push(i);
    }

    if (bestIdx < 0) return { dist: Infinity, normal: V.make(0, 0, 1) };

    if (violated.length >= 3) {
      for (const c of this.corners) {
        if (violated.includes(c.a) && violated.includes(c.b) && violated.includes(c.c)) {
          const away = V.sub(p, c.center);
          const len = V.length(away);
          if (len < 1e-6) return { dist: c.r, normal: V.neg(this.planes[c.a].n) };
          return { dist: c.r - len, normal: V.scale(away, -1 / len) };
        }
      }
    }

    if (violated.length >= 2) {
      for (const e of this.edges) {
        if (!violated.includes(e.a) || !violated.includes(e.b)) continue;
        const rel = V.sub(p, e.origin);
        const along = V.dot(rel, e.dir);
        const radial = V.sub(rel, V.scale(e.dir, along));
        const len = V.length(radial);
        if (len < 1e-6) return { dist: e.r, normal: V.neg(this.planes[e.a].n) };
        return { dist: e.r - len, normal: V.scale(radial, -1 / len) };
      }
    }

    return { dist: best, normal: V.neg(this.planes[bestIdx].n) };
  }
}

/** A goal post or crossbar, modelled as a capsule so the ball pings off it. */
export interface Post {
  a: Vec3;
  b: Vec3;
  radius: number;
}

function buildPosts(): Post[] {
  const posts: Post[] = [];
  const r = 22;
  for (const sy of [-1, 1] as const) {
    const y = sy * BACK_WALL_Y;
    for (const sx of [-1, 1] as const) {
      const x = sx * GOAL_CENTER_TO_POST;
      posts.push({ a: V.make(x, y, 0), b: V.make(x, y, GOAL_HEIGHT), radius: r });
    }
    // Crossbar.
    posts.push({
      a: V.make(-GOAL_CENTER_TO_POST, y, GOAL_HEIGHT),
      b: V.make(GOAL_CENTER_TO_POST, y, GOAL_HEIGHT),
      radius: r,
    });
  }
  return posts;
}

function closestPointOnSegment(p: Vec3, a: Vec3, b: Vec3): Vec3 {
  const ab = V.sub(b, a);
  const len2 = V.lengthSq(ab);
  if (len2 < 1e-9) return a;
  let t = V.dot(V.sub(p, a), ab) / len2;
  t = t < 0 ? 0 : t > 1 ? 1 : t;
  return V.addScaled(a, ab, t);
}

export class Field {
  private readonly arena = new ConvexCell(buildArenaPlanes());
  private readonly goals: Record<'neg' | 'pos', ConvexCell> = {
    neg: new ConvexCell(buildGoalPlanes(-1)),
    pos: new ConvexCell(buildGoalPlanes(1)),
  };
  private readonly posts = buildPosts();

  /**
   * True when `p` is within the rectangular prism of a goal mouth, i.e. in the
   * region where the back wall has a hole in it.
   */
  inGoalMouth(p: Vec3): boolean {
    return Math.abs(p.x) <= GOAL_CENTER_TO_POST && p.z >= 0 && p.z <= GOAL_HEIGHT;
  }

  /** Which goal recess (if any) contains `p`. */
  private goalCell(p: Vec3): ConvexCell | null {
    if (!this.inGoalMouth(p)) return null;
    if (p.y > BACK_WALL_Y) return this.goals.pos;
    if (p.y < -BACK_WALL_Y) return this.goals.neg;
    return null;
  }

  /**
   * Nearest surface to `p`. Handles the goal recesses transparently: inside a
   * goal the recess planes take over, and approaching the mouth from the field
   * the back wall is masked out so the ball flies through the hole.
   */
  query(p: Vec3): SurfaceQuery {
    const goal = this.goalCell(p);
    if (goal) return goal.query(p);

    if (this.inGoalMouth(p)) {
      // Standing in the mouth but still in front of the wall plane: the wall
      // isn't there, so ignore it.
      const mask = p.y > 0 ? 'wall-y+' : 'wall-y-';
      return this.arena.query(p, (tag) => tag === mask);
    }
    return this.arena.query(p);
  }

  /**
   * Collide a sphere against the arena. Returns null when there is no overlap.
   * Also tests the goal posts, which are capsules rather than part of the SDF.
   */
  collideSphere(center: Vec3, radius: number): Contact | null {
    let contact: Contact | null = null;

    const q = this.query(center);
    if (q.dist < radius) {
      const depth = radius - q.dist;
      contact = {
        point: V.addScaled(center, q.normal, -q.dist),
        normal: q.normal,
        depth,
      };
    }

    // Posts are thin and sit right at the mouth boundary, where the SDF has a
    // discontinuity; testing them explicitly gives a clean ping off the frame.
    for (const post of this.posts) {
      const c = closestPointOnSegment(center, post.a, post.b);
      const away = V.sub(center, c);
      const dist = V.length(away);
      const overlap = post.radius + radius - dist;
      if (overlap <= 0 || dist < 1e-6) continue;
      if (contact && contact.depth >= overlap) continue;
      const normal = V.scale(away, 1 / dist);
      contact = {
        point: V.addScaled(c, normal, post.radius),
        normal,
        depth: overlap,
      };
    }

    return contact;
  }

  /**
   * Cast a ray from inside the arena and return the distance to the boundary,
   * or `maxDist` if nothing is hit within range.
   *
   * Sphere-tracing: the SDF is a conservative underestimate of the true
   * distance, so stepping by it never overshoots the surface. On a convex,
   * mostly-planar region it converges in a handful of steps.
   */
  raycast(origin: Vec3, dir: Vec3, maxDist: number): { dist: number; normal: Vec3 } | null {
    let t = 0;
    let last = this.query(origin);
    if (last.dist <= 0) return { dist: 0, normal: last.normal };

    for (let i = 0; i < 32; i++) {
      const p = V.addScaled(origin, dir, t);
      const q = this.query(p);
      last = q;
      if (q.dist <= 0) return { dist: t, normal: q.normal };
      if (q.dist < 2) {
        // Close enough that the surface is locally a plane: finish in one exact
        // step instead of creeping up on it. Sphere tracing alone would leave a
        // sub-unit gap, which shows up directly as ride-height error.
        const closing = -V.dot(dir, q.normal);
        const remaining = closing > 0.05 ? q.dist / closing : q.dist;
        const hit = t + remaining;
        return hit <= maxDist ? { dist: hit, normal: q.normal } : null;
      }
      t += q.dist;
      if (t > maxDist) return null;
    }
    return t <= maxDist ? { dist: t, normal: last.normal } : null;
  }

  /** Signed distance from `p` to the boundary; positive inside. */
  distance(p: Vec3): number {
    return this.query(p).dist;
  }

  /** True when the ball centre has fully crossed the given goal line. */
  static isGoal(ballY: number, threshold: number): -1 | 1 | 0 {
    if (ballY > threshold) return 1;
    if (ballY < -threshold) return -1;
    return 0;
  }
}

export const field = new Field();
