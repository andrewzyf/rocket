/**
 * The car controller.
 *
 * This is not a car simulation. It is a hand-authored force/torque model
 * reproducing the numbers in DESIGN.md sections 4-6: a velocity-dependent
 * throttle curve, a yaw-rate servo driven by a turn-radius table, scripted
 * dodge torques, and a torque servo for air control. Nothing here comes out of
 * a rigid-body solver, which is exactly why one isn't used.
 *
 * Frame note: the published constants come from a left-handed (Unreal) engine.
 * We work right-handed, with body columns (forward, left, up). Magnitudes are
 * taken from the sources verbatim; the *signs* are chosen so the behaviour is
 * correct by definition and pinned by tests -- steering right turns right, a
 * forward dodge pitches the nose down, and so on.
 */

import { M, V, clamp, sign, type Mat3, type Vec3 } from '../core/math';
import {
  AIR_DAMPING,
  AIR_INERTIA,
  AIR_TORQUE,
  BOOST_ACCEL_AIR,
  BOOST_ACCEL_GROUND,
  BOOST_CONSUMPTION,
  BOOST_MAX,
  BOOST_TARGET_SPEED,
  BRAKE_FORCE,
  BRAKING_THRESHOLD,
  CAR_INERTIA_DIAG,
  CAR_MASS,
  CAR_MAX_ANGULAR,
  CAR_MAX_SPEED,
  COAST_FORCE,
  DEFAULT_BODY,
  DODGE_FORWARD_TORQUE,
  DODGE_IMPULSE,
  DODGE_INPUT_THRESHOLD,
  DODGE_PITCH_LOCK,
  DODGE_SIDE_TORQUE,
  DODGE_TIMEOUT,
  DODGE_TORQUE_TIME,
  DODGE_Z_DAMPING,
  DODGE_Z_DAMPING_END,
  DODGE_Z_DAMPING_START,
  GRAVITY,
  HANDBRAKE,
  JUMP_ACCEL,
  JUMP_EARLY_BACK_ACCEL,
  JUMP_MAX_DURATION,
  JUMP_MIN_DURATION,
  JUMP_SPEED,
  LATERAL,
  MIN_DRIVE_SPEED,
  STICKY_FORCE,
  SUPERSONIC_HOLD,
  SUPERSONIC_KEEP,
  SUPERSONIC_THRESHOLD,
  SUPERSONIC_TURN_DRAG,
  THROTTLE_ACCEL_AIR,
  THROTTLE_CURVE,
  THROTTLE_DEADZONE,
  TURN_DAMPING,
  YAW_SERVO_GAIN,
  type BodyType,
} from '../core/constants';
import type { Field } from './field';

export interface CarInput {
  /** -1 (reverse/brake) .. 1 (accelerate). */
  throttle: number;
  /** -1 (left) .. 1 (right). */
  steer: number;
  /** -1 (nose down) .. 1 (nose up); airborne only. */
  pitch: number;
  /** -1 (left) .. 1 (right); airborne only. */
  yaw: number;
  /** -1 .. 1; airborne only, and only while air-roll is engaged. */
  roll: number;
  jump: boolean;
  boost: boolean;
  handbrake: boolean;
}

export function neutralInput(): CarInput {
  return {
    throttle: 0,
    steer: 0,
    pitch: 0,
    yaw: 0,
    roll: 0,
    jump: false,
    boost: false,
    handbrake: false,
  };
}

/** Ride height: the car origin sits this far above the surface. */
export const WHEEL_RADIUS = 17;
/** How far a wheel may leave the surface before the car counts as airborne. */
export const GROUND_TRAVEL = 12;
/** Outward speed above which the car is treated as having left the surface. */
export const SEPARATION_SPEED = 50;
/** How long a car rests on its roof before it rights itself. */
export const UPRIGHT_DELAY = 0.45;
/** Angular acceleration applied while auto-righting. */
export const UPRIGHT_RATE = 14;

/**
 * Turn radius as a function of speed (DESIGN.md 4.3). Returns curvature in
 * 1/uu -- higher means a tighter circle. This is why the car turns sharply at
 * walking pace and barely at all when supersonic.
 */
/**
 * Measured throttle acceleration at a given forward speed (DESIGN.md 4.1).
 * Falls from 1600 uu/s^2 at rest to zero at 1410 uu/s -- the reason a car
 * without boost creeps up to top speed and then simply stops gaining.
 */
export function throttleAccel(speed: number): number {
  const v = Math.abs(speed);
  for (let i = 0; i < THROTTLE_CURVE.length - 1; i++) {
    const [x0, y0] = THROTTLE_CURVE[i];
    const [x1, y1] = THROTTLE_CURVE[i + 1];
    if (v >= x0 && v < x1) return y0 + ((y1 - y0) * (v - x0)) / (x1 - x0);
  }
  return 0;
}

export function maxCurvature(speed: number): number {
  const v = clamp(speed, 0, 2500);
  if (v < 500) return 0.0069 - 5.84e-6 * v;
  if (v < 1000) return 0.00561 - 3.26e-6 * v;
  if (v < 1500) return 0.0043 - 1.95e-6 * v;
  if (v < 1750) return 0.003025 - 1.1e-6 * v;
  if (v < 2300) return 0.0018 - 4.0e-7 * v;
  return 0.00088;
}

export interface WheelContact {
  /** World-space position of the wheel's contact patch. */
  point: Vec3;
  normal: Vec3;
  /** Distance from the wheel origin to the surface. */
  distance: number;
  touching: boolean;
}

export class Car {
  position: Vec3 = V.make(0, 0, WHEEL_RADIUS);
  velocity: Vec3 = V.zero();
  angularVelocity: Vec3 = V.zero();
  orientation: Mat3 = M.identity();

  boost = 33;
  team = 0;
  index = 0;
  body: BodyType = DEFAULT_BODY;

  onGround = false;
  /** Surface normal under the wheels; world up while airborne. */
  groundNormal: Vec3 = V.make(0, 0, 1);

  jumped = false;
  doubleJumped = false;
  /** Seconds since the first jump; -1 when not jumping. */
  jumpTimer = -1;
  /** Seconds into the current dodge; -1 when not dodging. */
  dodgeTimer = -1;
  dodgeTorque: Vec3 = V.zero();
  holdingJumpAccel = false;
  /** Ticks remaining during which sticky force is suppressed after a jump. */
  stickySuppress = 0;

  supersonic = false;
  private supersonicTimer = 0;

  demolished = false;
  respawnTimer = 0;

  /** Rising-edge detection for the jump button. */
  private prevJump = false;
  /** Smoothed handbrake engagement, for a non-instant grip transition. */
  private slideBlend = 0;
  /** How long the car has been resting inverted, for auto-righting. */
  private uprightTimer = 0;

  readonly wheels: WheelContact[] = [];

  constructor(team = 0, index = 0, body: BodyType = DEFAULT_BODY) {
    this.team = team;
    this.index = index;
    this.body = body;
    for (let i = 0; i < 4; i++) {
      this.wheels.push({
        point: V.zero(),
        normal: V.make(0, 0, 1),
        distance: WHEEL_RADIUS,
        touching: false,
      });
    }
  }

  get forward(): Vec3 {
    return M.col(this.orientation, 0);
  }

  get left(): Vec3 {
    return M.col(this.orientation, 1);
  }

  get up(): Vec3 {
    return M.col(this.orientation, 2);
  }

  get right(): Vec3 {
    return V.neg(M.col(this.orientation, 1));
  }

  get speed(): number {
    return V.length(this.velocity);
  }

  get forwardSpeed(): number {
    return V.dot(this.velocity, this.forward);
  }

  /** World-space inertia tensor inverse, for collision impulses. */
  get inverseInertiaWorld(): Mat3 {
    const local = M.diagonal(
      1 / (CAR_MASS * CAR_INERTIA_DIAG.x),
      1 / (CAR_MASS * CAR_INERTIA_DIAG.y),
      1 / (CAR_MASS * CAR_INERTIA_DIAG.z),
    );
    return M.mul(M.mul(this.orientation, local), M.transpose(this.orientation));
  }

  /** Centre of the collision box in world space (offset from the car origin). */
  get hitboxCenter(): Vec3 {
    const o = this.body.hitboxOffset;
    return V.add(this.position, M.mulVec(this.orientation, V.make(o.x, o.y, o.z)));
  }

  /** True while a flip is still available (second jump not yet spent). */
  get canDodge(): boolean {
    if (this.doubleJumped) return false;
    if (this.onGround) return false;
    if (!this.jumped) return false;
    return this.jumpTimer >= 0 && this.jumpTimer < DODGE_TIMEOUT + JUMP_MAX_DURATION;
  }

  get isDodging(): boolean {
    return this.dodgeTimer >= 0 && this.dodgeTimer <= DODGE_TORQUE_TIME;
  }

  /** Wheel positions in body space; z = 0 because the origin is at axle height. */
  private wheelOffsets(): Vec3[] {
    const h = this.body.halfExtents;
    const off = this.body.hitboxOffset;
    const dx = h.x * 0.72;
    const dy = h.y * 0.95;
    return [
      V.make(off.x + dx, dy, 0),
      V.make(off.x + dx, -dy, 0),
      V.make(off.x - dx, dy, 0),
      V.make(off.x - dx, -dy, 0),
    ];
  }

  reset(position: Vec3, yaw: number, boost: number): void {
    this.position = V.clone(position);
    this.velocity = V.zero();
    this.angularVelocity = V.zero();
    this.orientation = M.fromYaw(yaw);
    this.boost = boost;
    this.onGround = true;
    this.groundNormal = V.make(0, 0, 1);
    this.jumped = false;
    this.doubleJumped = false;
    this.jumpTimer = -1;
    this.dodgeTimer = -1;
    this.dodgeTorque = V.zero();
    this.holdingJumpAccel = false;
    this.stickySuppress = 0;
    this.supersonic = false;
    this.supersonicTimer = 0;
    this.demolished = false;
    this.respawnTimer = 0;
    this.prevJump = false;
    this.slideBlend = 0;
    this.uprightTimer = 0;
  }

  demolish(): void {
    this.demolished = true;
    this.velocity = V.zero();
    this.angularVelocity = V.zero();
  }

  // ------------------------------------------------------------- main step

  step(input: CarInput, dt: number, field: Field): void {
    if (this.demolished) {
      this.respawnTimer -= dt;
      this.prevJump = input.jump;
      return;
    }

    const jumpPressed = input.jump && !this.prevJump;
    this.prevJump = input.jump;

    this.updateGroundState(field);

    if (this.jumpTimer >= 0) this.jumpTimer += dt;
    if (this.dodgeTimer >= 0) {
      this.dodgeTimer += dt;
      // Expire the dodge once its torque window closes. Leaving it running
      // keeps the vertical damping alive, which turns every landing into a
      // 15 uu/s float down.
      if (this.dodgeTimer > DODGE_TORQUE_TIME) this.dodgeTimer = -1;
    }
    if (this.stickySuppress > 0) this.stickySuppress--;

    if (this.onGround) {
      if (jumpPressed) {
        this.startJump();
        this.integrateAir(input, dt);
      } else {
        this.drive(input, dt, field);
      }
    } else {
      if (jumpPressed && this.canDodge) {
        this.startDodgeOrDoubleJump(input);
      }
      this.integrateAir(input, dt);
    }

    this.consumeBoost(input, dt);
    this.clampMotion();
    this.resolveBodyCollision(field, dt);
    this.updateSupersonic(dt);

    this.orientation = M.orthonormalize(this.orientation);
  }

  // ------------------------------------------------------------ ground state

  /**
   * Cast each wheel along the car's local down axis. Contact with any wheel
   * counts as grounded, which is what allows a car to hang off an edge or ride
   * the curved floor-to-wall transition without popping into the air.
   */
  private updateGroundState(field: Field): void {
    const down = V.neg(this.up);
    const offsets = this.wheelOffsets();
    let touching = 0;
    let normalSum = V.zero();
    let minDistance = Infinity;

    // A car that has just jumped, or is otherwise moving away from the surface
    // fast, gets no suspension band: it leaves immediately rather than being
    // yanked back down by the re-seat below.
    const leaving =
      this.stickySuppress > 0 ||
      V.dot(this.velocity, this.up) > SEPARATION_SPEED;
    const band = leaving ? 0 : GROUND_TRAVEL;

    for (let i = 0; i < 4; i++) {
      const origin = V.add(this.position, M.mulVec(this.orientation, offsets[i]));
      const hit = field.raycast(origin, down, WHEEL_RADIUS + GROUND_TRAVEL + 20);
      const wheel = this.wheels[i];
      wheel.point = origin;
      if (hit && hit.dist <= WHEEL_RADIUS + band) {
        wheel.distance = hit.dist;
        wheel.normal = hit.normal;
        wheel.touching = true;
        touching++;
        normalSum = V.add(normalSum, hit.normal);
        minDistance = Math.min(minDistance, hit.dist);
      } else {
        wheel.distance = hit ? hit.dist : Infinity;
        wheel.normal = V.make(0, 0, 1);
        wheel.touching = false;
      }
    }

    const wasGround = this.onGround;
    // A dodge in progress keeps the car airborne until its torque expires, so a
    // flip that clips the ground doesn't get cancelled halfway through.
    this.onGround = touching > 0;

    if (this.onGround) {
      this.groundNormal = V.normalize(normalSum);
      this.snapToSurface(minDistance);
      if (!wasGround) this.onLanded();
    } else {
      this.groundNormal = V.make(0, 0, 1);
    }
  }

  /**
   * Align the car flat to the surface and sit it at ride height. Cars in this
   * genre are glued to whatever they are driving on -- this snap is what makes
   * wall and ceiling driving work at all.
   */
  private snapToSurface(minDistance: number): void {
    const n = this.groundNormal;
    const forwardOnSurface = V.reject(this.forward, n);
    if (V.lengthSq(forwardOnSurface) > 1e-6) {
      this.orientation = M.fromForwardUp(forwardOnSurface, n);
    }

    if (Number.isFinite(minDistance)) {
      const correction = WHEEL_RADIUS - minDistance;
      this.position = V.addScaled(this.position, n, correction);
    }

    // Kill any velocity heading into the surface, and any rotation that isn't
    // yaw about the surface normal: a grounded car only spins one way.
    const into = V.dot(this.velocity, n);
    if (into < 0) this.velocity = V.addScaled(this.velocity, n, -into);
    this.angularVelocity = V.scale(n, V.dot(this.angularVelocity, n));
  }

  private onLanded(): void {
    this.jumped = false;
    this.doubleJumped = false;
    this.jumpTimer = -1;
    this.dodgeTimer = -1;
    this.dodgeTorque = V.zero();
    this.holdingJumpAccel = false;
  }

  /**
   * Re-arm the flip without touching the ground. Any wheel contact with a
   * surface or the ball does this -- the "flip reset" falls straight out of it.
   */
  resetFlip(): void {
    this.doubleJumped = false;
    this.jumped = true;
    this.jumpTimer = 0;
  }

  // ----------------------------------------------------------------- driving

  private drive(input: CarInput, dt: number, field: Field): void {
    const n = this.groundNormal;
    const f = this.forward;
    const r = this.right;

    const vf = V.dot(this.velocity, f);
    const vr = V.dot(this.velocity, r);
    // Positive when yawing to the right, matching the source's sign convention.
    const turnRight = -V.dot(this.angularVelocity, n);

    const slideTarget = input.handbrake ? 1 : 0;
    const blendRate = dt / Math.max(HANDBRAKE.blendTime, 1e-4);
    this.slideBlend += clamp(slideTarget - this.slideBlend, -blendRate, blendRate);
    const slide = this.slideBlend;

    const forwardAccel = this.driveForceForward(input, vf, vr, turnRight);
    const lateralAccel = this.driveForceLateral(input, vf, vr, turnRight) * (1 - slide * (1 - HANDBRAKE.gripScale));

    let accel = V.addScaled(V.scale(f, forwardAccel), r, lateralAccel);
    accel = V.addScaled(accel, f, slide * HANDBRAKE.forwardDrag * sign(vf));

    // Gravity acts fully; its into-surface part is removed by snapToSurface, so
    // on a wall only the tangential component survives and the car slides down.
    accel = V.add(accel, V.make(0, 0, -GRAVITY));
    if (this.stickySuppress === 0) accel = V.addScaled(accel, n, -STICKY_FORCE);

    this.velocity = V.addScaled(this.velocity, accel, dt);

    // Yaw servo. The handbrake raises the reachable curvature, which is the
    // whole point of it: rotate tighter without paying the speed a brake costs.
    const curvature = maxCurvature(Math.abs(vf)) * (1 + slide * (HANDBRAKE.curvatureBoost - 1));
    const targetYawRate = -input.steer * curvature * vf;
    const yawAccel = YAW_SERVO_GAIN * (targetYawRate - V.dot(this.angularVelocity, n));
    this.angularVelocity = V.addScaled(this.angularVelocity, n, yawAccel * dt);

    this.integrateTransform(dt);
    // Re-seat on the surface after moving, so the next tick starts clean.
    void field;
  }

  /**
   * DESIGN.md 4.1. Returns an acceleration in uu/s^2 along the nose.
   *
   * The shape that matters: throttle force falls off linearly from 1550 at rest
   * to zero at 1550 uu/s, but a hard gate at 1450 means the car settles around
   * 1410. Boosting below 1450 uses a velocity-dependent term instead, which is
   * why boost from a standstill feels so much stronger than boost at speed.
   */
  private driveForceForward(input: CarInput, vf: number, vr: number, turnRight: number): number {
    // The published lateral coefficient is positive, so with a small standing
    // lateral velocity this bracket can go positive and the "damping" term
    // starts *adding* speed without bound (~0.5 uu/s per second). Clamping the
    // bracket at zero keeps it dissipative, which is plainly the intent.
    const turnDamping =
      Math.min(
        0,
        TURN_DAMPING.steer * Math.abs(input.steer) +
          TURN_DAMPING.yawRate * Math.abs(turnRight) +
          TURN_DAMPING.lateral * Math.abs(vr),
      ) * vf;

    if (input.boost && this.boost > 0) {
      // Boosting while reversing brakes hard instead of accelerating backwards.
      if (vf < 0) return -BRAKE_FORCE;
      if (vf >= BOOST_TARGET_SPEED) return SUPERSONIC_TURN_DRAG * Math.abs(turnRight);
      return throttleAccel(vf) + BOOST_ACCEL_GROUND + turnDamping;
    }

    const braking = input.throttle * sign(vf) <= BRAKING_THRESHOLD;
    if (braking && Math.abs(vf) > MIN_DRIVE_SPEED) {
      return BRAKE_FORCE * sign(vf);
    }
    if (Math.abs(input.throttle) < THROTTLE_DEADZONE && Math.abs(vf) > MIN_DRIVE_SPEED) {
      return COAST_FORCE * sign(vf) + turnDamping;
    }
    return input.throttle * throttleAccel(vf) + turnDamping;
  }

  /**
   * DESIGN.md 4.2. Lateral grip, positive to the right.
   *
   * The exponential term is the important one: grip scales in with speed, so a
   * stationary car cannot turn at all no matter how hard you push the stick.
   */
  private driveForceLateral(input: CarInput, vf: number, vr: number, turnRight: number): number {
    const gripFade = 1 - Math.exp(-LATERAL.speedFalloff * Math.abs(vf));
    return (
      (LATERAL.steer * input.steer +
        LATERAL.throttle * input.throttle +
        LATERAL.lateralSpeed * vr +
        LATERAL.yawRate * turnRight) *
      gripFade
    );
  }

  // ---------------------------------------------------------------- jumping

  private startJump(): void {
    this.velocity = V.addScaled(this.velocity, this.up, JUMP_SPEED);
    this.jumped = true;
    this.doubleJumped = false;
    this.jumpTimer = 0;
    this.holdingJumpAccel = true;
    this.onGround = false;
    this.stickySuppress = 3;
  }

  /**
   * The second jump. With no stick input it is a flat double jump; with input
   * it is a dodge, which is a planar velocity impulse plus a scripted torque
   * held for 0.65 s. See DESIGN.md 5.2.
   */
  private startDodgeOrDoubleJump(input: CarInput): void {
    const magnitude = Math.abs(input.pitch) + Math.abs(input.roll) + Math.abs(input.yaw);

    if (magnitude < DODGE_INPUT_THRESHOLD) {
      this.velocity = V.addScaled(this.velocity, this.up, JUMP_SPEED);
      this.dodgeTorque = V.zero();
      this.doubleJumped = true;
      // A flat double jump has no torque and no vertical damping.
      this.dodgeTimer = -1;
      return;
    }

    const vf = V.dot(this.velocity, this.forward);
    const speedFactor = Math.abs(vf) / CAR_MAX_SPEED;

    // Stick forward (pitch -1) dodges forward; stick right (yaw +1) dodges right.
    let dir = V.normalize(V.make(-input.pitch, input.yaw, 0));

    // Torque is computed from the un-snapped direction, so a near-diagonal input
    // still rotates diagonally even though the impulse gets squared up below.
    this.dodgeTorque = M.mulVec(
      this.orientation,
      V.make(-DODGE_SIDE_TORQUE * dir.y, DODGE_FORWARD_TORQUE * dir.x, 0),
    );

    // Snap near-cardinal inputs to exact cardinals so front/side flips are clean.
    dir = V.make(Math.abs(dir.x) < 0.1 ? 0 : dir.x, Math.abs(dir.y) < 0.1 ? 0 : dir.y, 0);

    const backward =
      Math.abs(vf) < 100 ? dir.x < 0 : dir.x >= 0 !== vf > 0;

    let dvForward = DODGE_IMPULSE * dir.x;
    let dvRight = DODGE_IMPULSE * dir.y;
    // A dodge against the direction of travel gets extra punch -- this is what
    // makes a backflip cancel forward speed and reverse rather than just stall.
    if (backward) dvForward *= (16 / 15) * (1 + 1.5 * speedFactor);
    dvRight *= 1 + 0.9 * speedFactor;

    // The impulse is horizontal in world space, using the car's heading at the
    // moment of the dodge -- dodging while nose-up does not launch you upward.
    const heading = Math.atan2(this.forward.y, this.forward.x);
    const cos = Math.cos(heading);
    const sin = Math.sin(heading);
    const world = V.make(
      dvForward * cos + dvRight * sin,
      dvForward * sin - dvRight * cos,
      0,
    );

    this.velocity = V.add(this.velocity, world);
    this.doubleJumped = true;
    this.dodgeTimer = 0;
  }

  // ------------------------------------------------------------ air control

  /**
   * DESIGN.md 6. Torque servo with per-axis drive and damping coefficients.
   *
   * Roll authority is roughly 3x pitch and 4x yaw, which is why high-level play
   * is built around air-roll. Damping on pitch and yaw is *reduced* while the
   * stick is held, so the car keeps rotating under input and stops crisply on
   * release -- that release-to-stop behaviour is a big part of aerial feel.
   */
  private integrateAir(input: CarInput, dt: number): void {
    let accel = V.make(0, 0, -GRAVITY);

    if (input.boost && this.boost > 0) {
      accel = V.addScaled(accel, this.forward, BOOST_ACCEL_AIR + THROTTLE_ACCEL_AIR);
    } else {
      accel = V.addScaled(accel, this.forward, input.throttle * THROTTLE_ACCEL_AIR);
    }

    if (input.jump && this.holdingJumpAccel) {
      if (this.jumpTimer < JUMP_MIN_DURATION) {
        accel = V.addScaled(accel, this.up, 0.75 * JUMP_ACCEL);
        accel = V.addScaled(accel, this.forward, JUMP_EARLY_BACK_ACCEL);
      } else {
        accel = V.addScaled(accel, this.up, JUMP_ACCEL);
      }
    }
    if (!input.jump || this.jumpTimer > JUMP_MAX_DURATION) {
      this.holdingJumpAccel = false;
    }

    this.velocity = V.addScaled(this.velocity, accel, dt);

    // Vertical damping partway through a dodge: this is why a front flip sticks
    // to the ground instead of floating.
    if (
      this.dodgeTimer >= DODGE_Z_DAMPING_START &&
      (this.velocity.z < 0 || this.dodgeTimer < DODGE_Z_DAMPING_END)
    ) {
      this.velocity = V.make(
        this.velocity.x,
        this.velocity.y,
        this.velocity.z * (1 - DODGE_Z_DAMPING),
      );
    }

    const pitch = this.dodgeTimer >= 0 && this.dodgeTimer <= DODGE_PITCH_LOCK ? 0 : input.pitch;

    if (this.dodgeTimer >= 0 && this.dodgeTimer <= DODGE_TORQUE_TIME) {
      this.angularVelocity = V.addScaled(this.angularVelocity, this.dodgeTorque, dt);
    } else {
      const wLocal = M.mulTVec(this.orientation, this.angularVelocity);
      const drive = V.make(
        AIR_TORQUE.roll * input.roll,
        AIR_TORQUE.pitch * pitch,
        AIR_TORQUE.yaw * input.yaw,
      );
      const damping = V.make(
        AIR_DAMPING.roll * wLocal.x,
        AIR_DAMPING.pitch * (1 - Math.abs(pitch)) * wLocal.y,
        AIR_DAMPING.yaw * (1 - Math.abs(input.yaw)) * wLocal.z,
      );
      const alpha = M.mulVec(this.orientation, V.scale(V.add(drive, damping), 1 / AIR_INERTIA));
      this.angularVelocity = V.addScaled(this.angularVelocity, alpha, dt);
    }

    this.integrateTransform(dt);
  }

  private integrateTransform(dt: number): void {
    this.position = V.addScaled(this.position, this.velocity, dt);
    this.orientation = M.mul(
      M.axisToRotation(V.scale(this.angularVelocity, dt)),
      this.orientation,
    );
  }

  // --------------------------------------------------------------- bookkeeping

  private consumeBoost(input: CarInput, dt: number): void {
    if (input.boost && this.boost > 0) {
      this.boost = Math.max(0, this.boost - BOOST_CONSUMPTION * dt);
    }
  }

  collectBoost(amount: number): void {
    this.boost = Math.min(BOOST_MAX, this.boost + amount);
  }

  private clampMotion(): void {
    this.velocity = V.clampLength(this.velocity, CAR_MAX_SPEED);
    this.angularVelocity = V.clampLength(this.angularVelocity, CAR_MAX_ANGULAR);
  }

  /**
   * Supersonic has hysteresis: once triggered you stay supersonic for a second
   * while above 2100, so the trail and FOV don't flicker on and off.
   */
  private updateSupersonic(dt: number): void {
    const speed = this.speed;
    if (speed >= SUPERSONIC_THRESHOLD) {
      this.supersonic = true;
      this.supersonicTimer = SUPERSONIC_HOLD;
    } else if (this.supersonic && speed >= SUPERSONIC_KEEP) {
      this.supersonicTimer -= dt;
      if (this.supersonicTimer <= 0) this.supersonic = false;
    } else {
      this.supersonic = false;
      this.supersonicTimer = 0;
    }
  }

  /** The eight corners of the collision box, in world space. */
  hitboxCorners(): Vec3[] {
    const h = this.body.halfExtents;
    const c = this.hitboxCenter;
    const out: Vec3[] = [];
    for (const sx of [-1, 1]) {
      for (const sy of [-1, 1]) {
        for (const sz of [-1, 1]) {
          out.push(
            V.add(c, M.mulVec(this.orientation, V.make(sx * h.x, sy * h.y, sz * h.z))),
          );
        }
      }
    }
    return out;
  }

  /**
   * Keep the collision box out of the walls. Only matters airborne or when the
   * car is jammed into a corner; grounded cars are already seated by
   * snapToSurface. Uses the deepest corner only -- resolving all eight fights
   * itself and jitters.
   */
  private resolveBodyCollision(field: Field, dt: number): void {
    let deepest = 0;
    let contactNormal: Vec3 | null = null;
    let contactPoint: Vec3 | null = null;

    for (const corner of this.hitboxCorners()) {
      const q = field.query(corner);
      if (q.dist < deepest) {
        deepest = q.dist;
        contactNormal = q.normal;
        contactPoint = corner;
      }
    }
    if (!contactNormal || !contactPoint) {
      this.uprightTimer = 0;
      return;
    }

    const depth = -deepest;
    this.position = V.addScaled(this.position, contactNormal, depth);

    const r = V.sub(contactPoint, this.position);
    const pointVel = V.add(this.velocity, V.cross(this.angularVelocity, r));
    const normalSpeed = V.dot(pointVel, contactNormal);
    if (normalSpeed >= 0) return;

    // Low restitution: cars thud into walls, they don't bounce off them.
    const restitution = 0.2;
    const invI = this.inverseInertiaWorld;
    const rxn = V.cross(r, contactNormal);
    const angularTerm = V.dot(contactNormal, V.cross(M.mulVec(invI, rxn), r));
    const j = (-(1 + restitution) * normalSpeed) / (1 / CAR_MASS + angularTerm);

    const impulse = V.scale(contactNormal, j);
    this.velocity = V.addScaled(this.velocity, impulse, 1 / CAR_MASS);
    this.angularVelocity = V.add(
      this.angularVelocity,
      M.mulVec(invI, V.cross(r, impulse)),
    );

    // Tangential friction so the car scrubs along walls rather than gliding.
    const tangent = V.sub(pointVel, V.scale(contactNormal, normalSpeed));
    const tangentSpeed = V.length(tangent);
    if (tangentSpeed > 1) {
      const friction = Math.min(tangentSpeed, (Math.abs(j) / CAR_MASS) * 0.6);
      this.velocity = V.addScaled(this.velocity, V.scale(tangent, 1 / tangentSpeed), -friction);
    }

    this.autoRight(contactNormal, dt);
  }

  /**
   * Roll a car back onto its wheels after it comes to rest on its roof.
   *
   * Without this the wheel raycasts point away from the floor, the car never
   * counts as grounded, and the player is stranded with no way to recover. The
   * delay means a controlled roof landing during play is still yours to save.
   */
  private autoRight(contactNormal: Vec3, dt: number): void {
    const inverted = V.dot(this.up, contactNormal) < 0.2;
    if (!inverted || this.speed > 400) {
      this.uprightTimer = 0;
      return;
    }

    this.uprightTimer += dt;
    if (this.uprightTimer < UPRIGHT_DELAY) return;

    const axis = V.cross(this.up, contactNormal);
    const len = V.length(axis);
    if (len < 1e-4) {
      // Exactly upside down: nudge about the nose to break the symmetry.
      this.angularVelocity = V.addScaled(this.angularVelocity, this.forward, 2 * dt);
      return;
    }
    const angle = Math.atan2(len, V.dot(this.up, contactNormal));
    const torque = V.scale(axis, (UPRIGHT_RATE * angle) / len);
    this.angularVelocity = V.addScaled(this.angularVelocity, torque, dt);
  }
}
