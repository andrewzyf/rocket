/**
 * Ball physics.
 *
 * A sphere with a restitution of 0.6 -- noticeably deader than a real football,
 * which is what makes long bounces readable and dribbling possible. World
 * contacts use an impulse resolve with a Coulomb friction clamp so bounce
 * angles depend on spin.
 *
 * The car interaction (DESIGN.md 7.2) is two impulses, and only the first is
 * physical. The second is a bonus "kick" along the car-to-ball line that exists
 * purely to make hits feel powerful -- and is the reason a touch off a wheel or
 * a corner sends the ball somewhere the contact geometry doesn't justify. That
 * artifact is load-bearing for the feel, so it is reproduced deliberately.
 */

import { M, V, clamp, type Vec3 } from '../core/math';
import {
  BALL_COLLISION_RADIUS,
  BALL_DRAG,
  BALL_FRICTION,
  BALL_INERTIA,
  BALL_KICK_CURVE,
  BALL_KICK_FORWARD_BIAS,
  BALL_KICK_MAX_DV,
  BALL_KICK_Z_SCALE,
  BALL_MASS,
  BALL_MAX_ANGULAR,
  BALL_MAX_SPEED,
  BALL_RESTITUTION,
  CAR_MASS,
  GRAVITY,
} from '../core/constants';
import type { Car } from './car';
import type { Field } from './field';

/** Interpolate the kick scale curve at a given closing speed. */
export function kickScale(dv: number): number {
  const x = clamp(dv, 0, BALL_KICK_MAX_DV);
  for (let i = 0; i < BALL_KICK_CURVE.length - 1; i++) {
    const [x0, y0] = BALL_KICK_CURVE[i];
    const [x1, y1] = BALL_KICK_CURVE[i + 1];
    if (x >= x0 && x <= x1) {
      const t = x1 === x0 ? 0 : (x - x0) / (x1 - x0);
      return y0 + (y1 - y0) * t;
    }
  }
  return BALL_KICK_CURVE[BALL_KICK_CURVE.length - 1][1];
}

/** Closest point on an oriented box to a world point. */
export function closestPointOnBox(
  p: Vec3,
  center: Vec3,
  orientation: Float64Array,
  halfExtents: Vec3,
): Vec3 {
  const local = M.mulTVec(orientation, V.sub(p, center));
  const clamped = V.make(
    clamp(local.x, -halfExtents.x, halfExtents.x),
    clamp(local.y, -halfExtents.y, halfExtents.y),
    clamp(local.z, -halfExtents.z, halfExtents.z),
  );
  return V.add(center, M.mulVec(orientation, clamped));
}

export interface BallTouch {
  car: Car;
  point: Vec3;
  /** Magnitude of the total impulse applied to the ball, for audio/particles. */
  impulse: number;
}

export class Ball {
  position: Vec3 = V.make(0, 0, BALL_COLLISION_RADIUS);
  velocity: Vec3 = V.zero();
  angularVelocity: Vec3 = V.zero();

  /** Set for one tick after a car touch, so the renderer can react. */
  lastTouch: BallTouch | null = null;
  /** Magnitude of the last world-surface impulse, for bounce audio. */
  lastSurfaceImpulse = 0;

  reset(position?: Vec3): void {
    this.position = position ? V.clone(position) : V.make(0, 0, BALL_COLLISION_RADIUS);
    this.velocity = V.zero();
    this.angularVelocity = V.zero();
    this.lastTouch = null;
    this.lastSurfaceImpulse = 0;
  }

  get speed(): number {
    return V.length(this.velocity);
  }

  step(dt: number, field: Field): void {
    this.lastSurfaceImpulse = 0;
    const contact = field.collideSphere(this.position, BALL_COLLISION_RADIUS);

    if (contact) {
      const n = contact.normal;
      // Lever arm from the ball centre to the contact patch.
      const L = V.sub(contact.point, this.position);

      const mReduced = 1 / (1 / BALL_MASS + V.lengthSq(L) / BALL_INERTIA);
      const vPerp = V.scale(n, Math.min(V.dot(this.velocity, n), 0));
      const vPara = V.sub(V.sub(this.velocity, vPerp), V.cross(L, this.angularVelocity));

      const ratio = V.length(vPerp) / Math.max(V.length(vPara), 1e-4);
      const jPerp = V.scale(vPerp, -(1 + BALL_RESTITUTION) * BALL_MASS);
      // Clamping the tangential impulse by mu * ratio is the Coulomb model: it
      // is why a ball skidding along a wall picks up spin instead of sliding.
      const jPara = V.scale(vPara, -Math.min(1, BALL_FRICTION * ratio) * mReduced);
      const J = V.add(jPerp, jPara);

      this.angularVelocity = V.add(
        this.angularVelocity,
        V.scale(V.cross(L, J), 1 / BALL_INERTIA),
      );
      this.velocity = V.add(
        V.addScaled(this.velocity, J, 1 / BALL_MASS),
        V.scale(this.velocity, BALL_DRAG * dt),
      );
      this.position = V.addScaled(this.position, this.velocity, dt);

      if (contact.depth > 0) {
        this.position = V.addScaled(this.position, n, 1.001 * contact.depth);
      }
      this.lastSurfaceImpulse = V.length(J);
    } else {
      const accel = V.add(V.scale(this.velocity, BALL_DRAG), V.make(0, 0, -GRAVITY));
      this.velocity = V.addScaled(this.velocity, accel, dt);
      this.position = V.addScaled(this.position, this.velocity, dt);
    }

    this.angularVelocity = V.clampLength(this.angularVelocity, BALL_MAX_ANGULAR);
    this.velocity = V.clampLength(this.velocity, BALL_MAX_SPEED);
  }

  /**
   * Resolve a car touch. Must run before `step` for the tick, matching the
   * reference ordering. Returns true when contact occurred.
   */
  collideWithCar(car: Car): boolean {
    if (car.demolished) return false;

    const h = car.body.halfExtents;
    const center = car.hitboxCenter;
    const p = closestPointOnBox(
      this.position,
      center,
      car.orientation,
      V.make(h.x, h.y, h.z),
    );

    const delta = V.sub(p, this.position);
    const dist = V.length(delta);
    if (dist >= BALL_COLLISION_RADIUS || dist < 1e-6) return false;

    const n1 = V.scale(delta, 1 / dist);

    // --- (a) the physical impulse -------------------------------------------
    const Lb = M.antisym(V.sub(p, this.position));
    const Lc = M.antisym(V.sub(p, car.position));
    const invIc = car.inverseInertiaWorld;

    // Effective mass matrix for a contact between two rigid bodies.
    let A = M.diagonal(
      1 / BALL_MASS + 1 / CAR_MASS,
      1 / BALL_MASS + 1 / CAR_MASS,
      1 / BALL_MASS + 1 / CAR_MASS,
    );
    A = M.sub(A, M.scaleMat(M.mul(Lb, Lb), 1 / BALL_INERTIA));
    A = M.sub(A, M.mul(Lc, M.mul(invIc, Lc)));
    const Mm = M.invert(A);

    const deltaV = V.sub(
      V.sub(car.velocity, M.mulVec(Lc, car.angularVelocity)),
      V.sub(this.velocity, M.mulVec(Lb, this.angularVelocity)),
    );

    let J1 = M.mulVec(Mm, deltaV);
    const j1n = Math.min(V.dot(J1, n1), -1);
    const J1Perp = V.scale(n1, j1n);
    const J1Para = V.sub(J1, J1Perp);
    const ratio = V.length(J1Perp) / Math.max(V.length(J1Para), 1e-3);
    J1 = V.add(J1Perp, V.scale(J1Para, Math.min(1, BALL_FRICTION * ratio)));

    // --- (b) the non-physical "kick" ----------------------------------------
    // Radial from the CAR CENTRE, not the contact point. Flattened in z so hits
    // travel forward rather than up, and biased away from the nose axis so a
    // straight-on hit is weaker than an angled one.
    const f = car.forward;
    let n2 = V.sub(this.position, car.position);
    n2 = V.make(n2.x, n2.y, n2.z * BALL_KICK_Z_SCALE);
    n2 = V.normalize(V.sub(n2, V.scale(f, BALL_KICK_FORWARD_BIAS * V.dot(n2, f))));

    const dv = Math.min(V.length(V.sub(this.velocity, car.velocity)), BALL_KICK_MAX_DV);
    const J2 = V.scale(n2, BALL_MASS * dv * kickScale(dv));

    this.angularVelocity = V.add(
      this.angularVelocity,
      V.scale(M.mulVec(Lb, J1), 1 / BALL_INERTIA),
    );
    const total = V.add(J1, J2);
    this.velocity = V.addScaled(this.velocity, total, 1 / BALL_MASS);

    // Newton's third law for the physical half only; the bonus kick is free
    // energy by design and is not reflected back into the car.
    car.velocity = V.addScaled(car.velocity, J1, -1 / CAR_MASS);
    car.angularVelocity = V.sub(
      car.angularVelocity,
      M.mulVec(invIc, V.cross(V.sub(p, car.position), J1)),
    );

    this.lastTouch = { car, point: p, impulse: V.length(total) };
    return true;
  }
}
