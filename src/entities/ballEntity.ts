/**
 * Ball visuals: a faceted sphere with an emissive seam pattern drawn to a
 * canvas, plus a ground shadow ring and a speed-reactive glow.
 */

import * as THREE from 'three';
import { BALL_MAX_SPEED, BALL_RADIUS } from '../core/constants';
import { clamp } from '../core/math';
import type { Ball } from '../physics/ball';

function buildBallTexture(): THREE.CanvasTexture {
  const size = 512;
  const canvas = document.createElement('canvas');
  canvas.width = size;
  canvas.height = size;
  const ctx = canvas.getContext('2d')!;

  ctx.fillStyle = '#eef2ff';
  ctx.fillRect(0, 0, size, size);

  // Hex-ish lattice, drawn as an offset grid of rounded cells.
  const cell = size / 8;
  ctx.strokeStyle = '#2a2f55';
  ctx.lineWidth = 7;
  for (let row = 0; row < 9; row++) {
    for (let col = 0; col < 9; col++) {
      const x = col * cell + (row % 2 ? cell / 2 : 0);
      const y = row * cell;
      ctx.beginPath();
      ctx.arc(x, y, cell * 0.42, 0, Math.PI * 2);
      ctx.stroke();
    }
  }

  const tex = new THREE.CanvasTexture(canvas);
  tex.colorSpace = THREE.SRGBColorSpace;
  tex.anisotropy = 4;
  return tex;
}

export class BallEntity {
  readonly group = new THREE.Group();
  private readonly mesh: THREE.Mesh;
  private readonly glow: THREE.Mesh;
  private readonly shadow: THREE.Mesh;
  private readonly glowMaterial: THREE.MeshBasicMaterial;
  private readonly quaternion = new THREE.Quaternion();

  constructor(private readonly ball: Ball) {
    this.mesh = new THREE.Mesh(
      new THREE.IcosahedronGeometry(BALL_RADIUS, 3),
      new THREE.MeshStandardMaterial({
        map: buildBallTexture(),
        roughness: 0.55,
        metalness: 0.1,
      }),
    );
    this.mesh.castShadow = true;
    this.group.add(this.mesh);

    this.glowMaterial = new THREE.MeshBasicMaterial({
      color: 0xffd8a0,
      transparent: true,
      opacity: 0,
      blending: THREE.AdditiveBlending,
      depthWrite: false,
      side: THREE.BackSide,
    });
    this.glow = new THREE.Mesh(
      new THREE.IcosahedronGeometry(BALL_RADIUS * 1.22, 2),
      this.glowMaterial,
    );
    this.group.add(this.glow);

    // A flat ring on the floor so height over the pitch stays readable -- with
    // a ball this size, judging altitude from the shadow alone is hard.
    this.shadow = new THREE.Mesh(
      new THREE.RingGeometry(BALL_RADIUS * 0.35, BALL_RADIUS * 0.95, 28),
      new THREE.MeshBasicMaterial({
        color: 0x000000,
        transparent: true,
        opacity: 0.28,
        depthWrite: false,
      }),
    );
    this.shadow.position.z = 2;
  }

  addTo(scene: THREE.Scene): void {
    scene.add(this.group);
    scene.add(this.shadow);
  }

  update(dt: number): void {
    const ball = this.ball;
    this.group.position.set(ball.position.x, ball.position.y, ball.position.z);

    // Integrate the spin visually from angular velocity.
    const w = ball.angularVelocity;
    const speed = Math.hypot(w.x, w.y, w.z);
    if (speed > 1e-5) {
      const axis = new THREE.Vector3(w.x / speed, w.y / speed, w.z / speed);
      this.quaternion.setFromAxisAngle(axis, speed * dt);
      this.group.quaternion.premultiply(this.quaternion);
    }

    const heat = clamp(ball.speed / (BALL_MAX_SPEED * 0.42), 0, 1);
    this.glowMaterial.opacity = heat * 0.5;
    this.glow.scale.setScalar(1 + heat * 0.12);

    this.shadow.position.set(ball.position.x, ball.position.y, 2);
    const altitude = clamp(1 - (ball.position.z - BALL_RADIUS) / 1400, 0.15, 1);
    this.shadow.scale.setScalar(0.6 + altitude * 0.7);
    (this.shadow.material as THREE.MeshBasicMaterial).opacity = 0.3 * altitude;
  }

  setVisible(visible: boolean): void {
    this.group.visible = visible;
    this.shadow.visible = visible;
  }
}
