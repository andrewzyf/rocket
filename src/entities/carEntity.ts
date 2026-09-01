/**
 * Car visuals: an original low-poly silhouette built from an extruded side
 * profile, plus wheels, a team-coloured accent, boost flames and a trail.
 *
 * Every shape here is generated in code -- there are no imported meshes,
 * textures or decals anywhere in this project.
 *
 * The visual mesh deliberately does NOT match the collision box: the wheels sit
 * outside it and the nose is shorter than it. That mismatch is faithful to the
 * genre and is why touches sometimes look like they missed.
 */

import * as THREE from 'three';
import { M, V, clamp } from '../core/math';

/** Body sits this far above the axle line, so the wheels stay visible. */
const BODY_FLOOR = 8;
import { TEAM_COLORS, type BodyType } from '../core/constants';
import type { Car } from '../physics/car';
import type { Particles } from '../scenes/particles';

/**
 * Side profiles in normalised body space: x = forward over [-1, 1], y = height
 * over [0, 1]. Drawn nose-right. Each is an original silhouette; the family
 * differs in how long and how low it sits, mirroring the hitbox differences.
 */
const PROFILES: Record<string, Array<[number, number]>> = {
  // Short arrow: high rear haunch, scooped nose, raised cabin.
  wedge: [
    [-1.0, 0.1], [-1.02, 0.5], [-0.86, 0.78], [-0.52, 0.86], [-0.34, 1.0],
    [0.12, 1.0], [0.4, 0.82], [0.78, 0.66], [1.04, 0.4], [1.06, 0.12],
    [0.82, 0.02], [-0.84, 0.02],
  ],
  // Long and flat: a low deck that runs almost the whole length.
  slab: [
    [-1.0, 0.12], [-1.04, 0.48], [-0.78, 0.7], [-0.34, 0.8], [0.06, 0.82],
    [0.5, 0.66], [0.9, 0.44], [1.08, 0.16], [0.88, 0.02], [-0.86, 0.02],
  ],
  // Wide and flat: a broad flat top made for carrying the ball.
  kite: [
    [-1.0, 0.14], [-1.02, 0.52], [-0.72, 0.74], [-0.2, 0.78], [0.3, 0.74],
    [0.74, 0.56], [1.06, 0.3], [1.06, 0.1], [0.84, 0.02], [-0.86, 0.02],
  ],
};

function buildBodyGeometry(body: BodyType): THREE.BufferGeometry {
  const h = body.halfExtents;
  const profile = PROFILES[body.id] ?? PROFILES.wedge;

  const shape = new THREE.Shape();
  profile.forEach(([x, y], i) => {
    // The visible shell is a little shorter than the hitbox and noticeably
    // taller than it -- deliberately so: the box you collide with is not the
    // car you see, which is exactly the mismatch this genre is built on.
    const px = x * h.x * 1.02;
    const py = BODY_FLOOR + y * h.z * 2.15;
    if (i === 0) shape.moveTo(px, py);
    else shape.lineTo(px, py);
  });
  shape.closePath();

  const width = h.y * 1.78;
  const geo = new THREE.ExtrudeGeometry(shape, {
    depth: width,
    bevelEnabled: true,
    bevelThickness: 6,
    bevelSize: 6,
    bevelSegments: 2,
    steps: 1,
  });
  // The shape lives in XY and extrudes along +Z. Rotate so the profile ends up
  // in the car's forward/up plane and the extrusion becomes its width, then
  // centre it on the axle line.
  geo.rotateX(Math.PI / 2);
  geo.translate(0, width / 2, 0);
  geo.computeVertexNormals();
  return geo;
}

function buildWheelGeometry(radius: number): THREE.BufferGeometry {
  const geo = new THREE.CylinderGeometry(radius, radius, radius * 0.86, 14);
  // Cylinders are Y-aligned, which is exactly the axle direction we want.
  return geo;
}

export class CarEntity {
  readonly group = new THREE.Group();

  private readonly bodyMesh: THREE.Mesh;
  private readonly accentMesh: THREE.Mesh;
  private readonly wheels: THREE.Mesh[] = [];
  private readonly flames: THREE.Mesh[] = [];
  private readonly flameMaterial: THREE.MeshBasicMaterial;
  private readonly bodyMaterial: THREE.MeshStandardMaterial;

  private wheelSpin = 0;
  private boostHeat = 0;
  private smokeCooldown = 0;

  constructor(
    readonly car: Car,
    private readonly particles: Particles,
    paintColor?: number,
  ) {
    const teamColor = TEAM_COLORS[car.team];
    const paint = paintColor ?? teamColor;

    this.bodyMaterial = new THREE.MeshStandardMaterial({
      color: paint,
      roughness: 0.38,
      metalness: 0.45,
      flatShading: true,
    });
    this.bodyMesh = new THREE.Mesh(buildBodyGeometry(car.body), this.bodyMaterial);
    this.bodyMesh.castShadow = true;
    this.group.add(this.bodyMesh);

    // A single emissive stripe along the spine, in the team colour, so friend
    // and foe stay legible even with custom paint.
    const h = car.body.halfExtents;
    this.accentMesh = new THREE.Mesh(
      new THREE.BoxGeometry(h.x * 1.5, h.y * 0.26, 6),
      new THREE.MeshStandardMaterial({
        color: teamColor,
        emissive: teamColor,
        emissiveIntensity: 1.6,
        roughness: 0.3,
      }),
    );
    this.accentMesh.position.set(-h.x * 0.1, 0, BODY_FLOOR + h.z * 2.2);
    this.group.add(this.accentMesh);

    const wheelRadius = 17;
    const wheelGeo = buildWheelGeometry(wheelRadius);
    const wheelMat = new THREE.MeshStandardMaterial({
      color: 0x14141f,
      roughness: 0.9,
      flatShading: true,
    });
    const rimMat = new THREE.MeshStandardMaterial({
      color: 0xc9d2ff,
      roughness: 0.35,
      metalness: 0.7,
    });

    for (const sx of [1, -1]) {
      for (const sy of [1, -1]) {
        const wheel = new THREE.Mesh(wheelGeo, wheelMat);
        wheel.castShadow = true;
        wheel.position.set(
          car.body.hitboxOffset.x + sx * h.x * 0.72,
          sy * h.y * 1.03,
          0,
        );
        const rim = new THREE.Mesh(
          new THREE.CylinderGeometry(wheelRadius * 0.5, wheelRadius * 0.5, wheelRadius * 0.9, 10),
          rimMat,
        );
        wheel.add(rim);
        this.group.add(wheel);
        this.wheels.push(wheel);
      }
    }

    // Two exhaust flames, hidden until boost is held.
    this.flameMaterial = new THREE.MeshBasicMaterial({
      color: teamColor,
      transparent: true,
      opacity: 0.9,
      blending: THREE.AdditiveBlending,
      depthWrite: false,
    });
    // Cones point +Y and are built with the tip at +Y, base at -Y. Rotating
    // +90 degrees about Z aims the tip along -X, out the back of the car, and
    // translating the geometry first puts the base flush with the tail rather
    // than half-buried inside the body.
    const flameGeo = new THREE.ConeGeometry(11, 30, 8, 1, true);
    flameGeo.translate(0, 15, 0);
    for (const sy of [1, -1]) {
      const flame = new THREE.Mesh(flameGeo, this.flameMaterial);
      flame.rotation.z = Math.PI / 2;
      flame.position.set(-h.x * 0.9, sy * h.y * 0.44, BODY_FLOOR + h.z * 0.9);
      flame.visible = false;
      this.group.add(flame);
      this.flames.push(flame);
    }
  }

  setPaint(color: number): void {
    this.bodyMaterial.color.setHex(color);
  }

  /**
   * Push the simulation state into the scene graph. `alpha` interpolates
   * between physics ticks so motion stays smooth above 120 fps.
   */
  update(dt: number, boosting: boolean): void {
    const car = this.car;
    this.group.visible = !car.demolished;
    if (car.demolished) {
      this.boostHeat = 0;
      return;
    }

    this.group.position.set(car.position.x, car.position.y, car.position.z);

    // Copy the physics basis straight into the object matrix: columns are
    // (forward, left, up), which is the same convention the meshes are built in.
    const o = car.orientation;
    const basis = new THREE.Matrix4();
    basis.set(
      o[0], o[1], o[2], 0,
      o[3], o[4], o[5], 0,
      o[6], o[7], o[8], 0,
      0, 0, 0, 1,
    );
    this.group.quaternion.setFromRotationMatrix(basis);

    // Wheels spin with forward speed and steer visually with the yaw servo.
    const forwardSpeed = car.forwardSpeed;
    this.wheelSpin += (forwardSpeed / 17) * dt;
    const steerAngle = clamp(-V.dot(car.angularVelocity, car.up) * 0.35, -0.5, 0.5);
    this.wheels.forEach((wheel, i) => {
      wheel.rotation.set(0, 0, 0);
      if (i < 2) wheel.rotateZ(steerAngle);
      wheel.rotateY(-this.wheelSpin);
    });

    this.updateBoost(dt, boosting);
    this.updateSkids(dt);
  }

  private updateBoost(dt: number, boosting: boolean): void {
    const active = boosting && this.car.boost > 0;
    this.boostHeat = clamp(this.boostHeat + (active ? dt * 7 : -dt * 5), 0, 1);

    const heat = this.boostHeat;
    for (const flame of this.flames) {
      flame.visible = heat > 0.02;
      // Only the length flickers; a jittering radius reads as noise.
      const jitter = 0.85 + Math.random() * 0.3;
      const length = heat * (0.55 + this.car.speed / 2300) * jitter;
      flame.scale.set(heat, length, heat);
    }
    this.flameMaterial.opacity = (0.3 + 0.22 * Math.random()) * heat;

    if (!active) return;

    // Trail sparks are emitted in world space behind the car, so they hang in
    // the air instead of riding along with it.
    const car = this.car;
    const back = V.addScaled(car.position, car.forward, -car.body.halfExtents.x * 1.05);
    const up = V.addScaled(back, car.up, car.body.halfExtents.z);
    const color = car.supersonic ? 0xffffff : TEAM_COLORS[car.team];
    const count = car.supersonic ? 3 : 2;
    for (let i = 0; i < count; i++) {
      this.particles.emit({
        position: up,
        velocity: V.addScaled(V.scale(car.velocity, 0.18), car.forward, -520),
        spread: 90,
        life: 0.3 + Math.random() * 0.25,
        size: 15 + Math.random() * 12,
        endScale: 0.1,
        color,
        drag: 0.06,
      });
    }
  }

  /** Tyre smoke while powersliding or landing hard. */
  private updateSkids(dt: number): void {
    this.smokeCooldown -= dt;
    const car = this.car;
    if (!car.onGround || this.smokeCooldown > 0) return;

    const lateral = Math.abs(V.dot(car.velocity, car.right));
    if (lateral < 260) return;

    this.smokeCooldown = 0.02;
    for (const wheel of car.wheels) {
      if (!wheel.touching) continue;
      this.particles.emit({
        position: V.addScaled(wheel.point, car.up, -12),
        velocity: V.scale(car.velocity, 0.08),
        spread: 90,
        life: 0.45,
        size: 30,
        endScale: 2.4,
        color: 0x6b74a8,
        drag: 0.2,
      });
    }
  }

  dispose(): void {
    this.group.removeFromParent();
    this.bodyMesh.geometry.dispose();
    this.accentMesh.geometry.dispose();
  }
}

/** Small helper so callers don't need to import Mat3 details. */
export function carHeading(car: Car): number {
  const f = M.col(car.orientation, 0);
  return Math.atan2(f.y, f.x);
}
