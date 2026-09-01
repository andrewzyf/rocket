/**
 * Spring-arm chase camera (DESIGN.md 10).
 *
 * Two modes. Ball cam places the arm behind the car along the car-to-ball line
 * and looks at the ball, which is why it automatically frames the play. Car cam
 * trails the car's *velocity* rather than its heading, so a powerslide shows
 * you the drift instead of hiding it.
 *
 * The arm never rolls with the car -- a camera that rolls during an air-roll is
 * unplayable. World up is always up.
 */

import * as THREE from 'three';
import { CAMERA_DEFAULTS, SUPERSONIC_FOV_BONUS, SUPERSONIC_FOV_IN_RATE, SUPERSONIC_FOV_OUT_RATE } from '../core/constants';
import { V, clamp, damp, dampVec, lerp, type Vec3 } from '../core/math';
import type { Ball } from '../physics/ball';
import type { Car } from '../physics/car';
import { field } from '../physics/field';

export interface CameraSettings {
  fov: number;
  distance: number;
  height: number;
  /** Degrees; negative pitches the view down. */
  angle: number;
  stiffness: number;
  swivelSpeed: number;
  transitionSpeed: number;
  ballCam: boolean;
}

/** Below this speed, car cam falls back to the car's heading. */
const VELOCITY_FALLBACK_SPEED = 100;
/** Keep the camera at least this far off any wall. */
const WALL_CLEARANCE = 55;

export class ChaseCamera {
  readonly settings: CameraSettings = { ...CAMERA_DEFAULTS };

  /** Smoothed horizontal direction from the focus point back to the camera. */
  private armDirection: Vec3 = V.make(0, -1, 0);
  private smoothedPosition: Vec3 = V.make(0, -600, 300);
  private smoothedTarget: Vec3 = V.zero();
  private currentFov = CAMERA_DEFAULTS.fov;
  private initialised = false;

  /** Set while a goal replay is running; suspends normal following. */
  cinematic: { center: Vec3; radius: number; height: number; angle: number } | null = null;

  toggleBallCam(): boolean {
    this.settings.ballCam = !this.settings.ballCam;
    return this.settings.ballCam;
  }

  reset(): void {
    this.initialised = false;
    this.cinematic = null;
  }

  update(camera: THREE.PerspectiveCamera, car: Car, ball: Ball, dt: number): void {
    if (this.cinematic) {
      this.updateCinematic(camera, dt);
      return;
    }

    const focus = V.addScaled(car.position, V.make(0, 0, 1), 40);

    // --- where the arm should point -----------------------------------------
    let desired: Vec3;
    if (this.settings.ballCam) {
      const toBall = V.make(ball.position.x - car.position.x, ball.position.y - car.position.y, 0);
      desired = V.lengthSq(toBall) > 400 ? V.neg(V.normalize(toBall)) : V.clone(this.armDirection);
    } else {
      const flatVelocity = V.make(car.velocity.x, car.velocity.y, 0);
      const source =
        V.length(flatVelocity) > VELOCITY_FALLBACK_SPEED
          ? flatVelocity
          : V.make(car.forward.x, car.forward.y, 0);
      desired = V.lengthSq(source) > 1e-6 ? V.neg(V.normalize(source)) : V.clone(this.armDirection);
    }

    if (!this.initialised) {
      this.armDirection = desired;
      this.initialised = true;
      this.smoothedPosition = this.armPosition(focus, desired);
      this.smoothedTarget = this.lookTarget(car, ball);
    }

    this.armDirection = V.normalize(
      dampVec(this.armDirection, desired, this.settings.swivelSpeed * 2, dt),
    );

    // --- arm placement and smoothing ----------------------------------------
    const targetPosition = this.armPosition(focus, this.armDirection);
    // Stiffness 1.0 bolts the arm to the car; 0.0 lets it lag well behind.
    const positionRate = lerp(6, 40, clamp(this.settings.stiffness, 0, 1));
    this.smoothedPosition = dampVec(this.smoothedPosition, targetPosition, positionRate, dt);
    this.smoothedTarget = dampVec(
      this.smoothedTarget,
      this.lookTarget(car, ball),
      this.settings.transitionSpeed * 8,
      dt,
    );

    const placed = this.avoidWalls(this.smoothedPosition, focus);
    camera.position.set(placed.x, placed.y, placed.z);

    // --- look direction, with the configured downward tilt -------------------
    const toTarget = V.normalize(V.sub(this.smoothedTarget, placed));
    const right = V.normalize(V.cross(toTarget, V.make(0, 0, 1)));
    const tilt = (this.settings.angle * Math.PI) / 180;
    const direction = rotateAbout(toTarget, right, tilt);
    const look = V.addScaled(placed, direction, 1000);
    camera.up.set(0, 0, 1);
    camera.lookAt(look.x, look.y, look.z);

    // --- supersonic FOV kick -------------------------------------------------
    const targetFov = this.settings.fov + (car.supersonic ? SUPERSONIC_FOV_BONUS : 0);
    const rate = car.supersonic ? SUPERSONIC_FOV_IN_RATE : SUPERSONIC_FOV_OUT_RATE;
    this.currentFov = damp(this.currentFov, targetFov, rate, dt);
    if (Math.abs(camera.fov - this.currentFov) > 1e-3) {
      camera.fov = this.currentFov;
      camera.updateProjectionMatrix();
    }
  }

  private armPosition(focus: Vec3, direction: Vec3): Vec3 {
    return V.make(
      focus.x + direction.x * this.settings.distance,
      focus.y + direction.y * this.settings.distance,
      focus.z + this.settings.height,
    );
  }

  /**
   * Ball cam looks at the ball but biased toward the car, which keeps the car
   * low in frame rather than letting it slide off the bottom edge.
   */
  private lookTarget(car: Car, ball: Ball): Vec3 {
    if (!this.settings.ballCam) {
      return V.addScaled(car.position, V.make(0, 0, 1), 60);
    }
    const carFocus = V.addScaled(car.position, V.make(0, 0, 1), 50);
    const distance = V.distance(car.position, ball.position);
    // Far away, look almost entirely at the ball; up close, split the difference
    // so the camera doesn't swing wildly when you are on top of it.
    const bias = clamp(distance / 2500, 0.25, 0.78);
    return V.lerp(carFocus, ball.position, bias);
  }

  /** Push the camera back inside the arena if the arm has swung into a wall. */
  private avoidWalls(position: Vec3, focus: Vec3): Vec3 {
    const q = field.query(position);
    if (q.dist >= WALL_CLEARANCE) return position;
    const pushed = V.addScaled(position, q.normal, WALL_CLEARANCE - q.dist);
    // If it is still buried (a corner), fall back toward the car.
    return field.query(pushed).dist >= 1 ? pushed : V.lerp(pushed, focus, 0.5);
  }

  private updateCinematic(camera: THREE.PerspectiveCamera, dt: number): void {
    const shot = this.cinematic!;
    shot.angle += dt * 0.55;
    const pos = V.make(
      shot.center.x + Math.cos(shot.angle) * shot.radius,
      shot.center.y + Math.sin(shot.angle) * shot.radius,
      shot.center.z + shot.height,
    );
    const placed = this.avoidWalls(pos, shot.center);
    camera.position.set(placed.x, placed.y, placed.z);
    camera.up.set(0, 0, 1);
    camera.lookAt(shot.center.x, shot.center.y, shot.center.z);
    this.currentFov = damp(this.currentFov, this.settings.fov - 20, 3, dt);
    camera.fov = this.currentFov;
    camera.updateProjectionMatrix();
    this.initialised = false;
  }
}

/** Rodrigues rotation of `v` about unit `axis` by `angle`. */
function rotateAbout(v: Vec3, axis: Vec3, angle: number): Vec3 {
  const c = Math.cos(angle);
  const s = Math.sin(angle);
  return V.add(
    V.add(V.scale(v, c), V.scale(V.cross(axis, v), s)),
    V.scale(axis, V.dot(axis, v) * (1 - c)),
  );
}
