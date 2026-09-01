/**
 * A single pooled CPU particle system, shared by every effect in the game:
 * boost sparks, tyre smoke, ball-hit flashes, goal explosions, demolitions.
 *
 * One draw call, no allocations after construction, and dead particles are
 * swapped to the tail so the live set stays contiguous.
 */

import * as THREE from 'three';
import type { Vec3 } from '../core/math';

const MAX_PARTICLES = 4000;

export interface EmitOptions {
  position: Vec3;
  velocity: Vec3;
  /** Random velocity added per axis. */
  spread?: number;
  life: number;
  size: number;
  /** Size at the end of life, as a fraction of `size`. */
  endScale?: number;
  color: THREE.ColorRepresentation;
  /** Downward acceleration; 0 for sparks that should hang in the air. */
  gravity?: number;
  /** Velocity retained per second. */
  drag?: number;
}

export class Particles {
  readonly points: THREE.Points;

  private readonly position: Float32Array;
  private readonly color: Float32Array;
  private readonly size: Float32Array;
  private readonly alpha: Float32Array;

  private readonly vx = new Float32Array(MAX_PARTICLES);
  private readonly vy = new Float32Array(MAX_PARTICLES);
  private readonly vz = new Float32Array(MAX_PARTICLES);
  private readonly life = new Float32Array(MAX_PARTICLES);
  private readonly maxLife = new Float32Array(MAX_PARTICLES);
  private readonly startSize = new Float32Array(MAX_PARTICLES);
  private readonly endSize = new Float32Array(MAX_PARTICLES);
  private readonly gravity = new Float32Array(MAX_PARTICLES);
  private readonly drag = new Float32Array(MAX_PARTICLES);

  private count = 0;
  private readonly scratch = new THREE.Color();

  constructor() {
    const geo = new THREE.BufferGeometry();
    this.position = new Float32Array(MAX_PARTICLES * 3);
    this.color = new Float32Array(MAX_PARTICLES * 3);
    this.size = new Float32Array(MAX_PARTICLES);
    this.alpha = new Float32Array(MAX_PARTICLES);

    geo.setAttribute('position', new THREE.BufferAttribute(this.position, 3).setUsage(THREE.DynamicDrawUsage));
    geo.setAttribute('color', new THREE.BufferAttribute(this.color, 3).setUsage(THREE.DynamicDrawUsage));
    geo.setAttribute('particleSize', new THREE.BufferAttribute(this.size, 1).setUsage(THREE.DynamicDrawUsage));
    geo.setAttribute('particleAlpha', new THREE.BufferAttribute(this.alpha, 1).setUsage(THREE.DynamicDrawUsage));
    geo.setDrawRange(0, 0);
    // The bounding sphere is meaningless for a moving pool; skip culling.
    geo.boundingSphere = new THREE.Sphere(new THREE.Vector3(), 1e6);

    const material = new THREE.ShaderMaterial({
      transparent: true,
      depthWrite: false,
      blending: THREE.AdditiveBlending,
      uniforms: { uScale: { value: 1 } },
      vertexShader: `
        attribute float particleSize;
        attribute float particleAlpha;
        varying vec3 vColor;
        varying float vAlpha;
        uniform float uScale;
        void main() {
          vColor = color;
          vAlpha = particleAlpha;
          vec4 mv = modelViewMatrix * vec4(position, 1.0);
          gl_PointSize = particleSize * uScale / max(-mv.z, 1.0) * 900.0;
          gl_Position = projectionMatrix * mv;
        }`,
      fragmentShader: `
        varying vec3 vColor;
        varying float vAlpha;
        void main() {
          vec2 d = gl_PointCoord - vec2(0.5);
          float r = dot(d, d);
          if (r > 0.25) discard;
          float falloff = 1.0 - smoothstep(0.0, 0.25, r);
          gl_FragColor = vec4(vColor, vAlpha * falloff * falloff);
        }`,
      vertexColors: true,
    });

    this.points = new THREE.Points(geo, material);
    this.points.frustumCulled = false;
    this.points.renderOrder = 5;
  }

  emit(options: EmitOptions): void {
    if (this.count >= MAX_PARTICLES) return;
    const i = this.count++;
    const spread = options.spread ?? 0;

    this.position[i * 3] = options.position.x;
    this.position[i * 3 + 1] = options.position.y;
    this.position[i * 3 + 2] = options.position.z;

    this.vx[i] = options.velocity.x + (Math.random() - 0.5) * spread;
    this.vy[i] = options.velocity.y + (Math.random() - 0.5) * spread;
    this.vz[i] = options.velocity.z + (Math.random() - 0.5) * spread;

    this.life[i] = options.life;
    this.maxLife[i] = options.life;
    this.startSize[i] = options.size;
    this.endSize[i] = options.size * (options.endScale ?? 0);
    this.gravity[i] = options.gravity ?? 0;
    this.drag[i] = options.drag ?? 1;

    this.scratch.set(options.color);
    this.color[i * 3] = this.scratch.r;
    this.color[i * 3 + 1] = this.scratch.g;
    this.color[i * 3 + 2] = this.scratch.b;
  }

  /** Emit `n` particles in a sphere -- goal explosions and demolitions. */
  burst(position: Vec3, n: number, speed: number, options: Omit<EmitOptions, 'position' | 'velocity'>): void {
    for (let i = 0; i < n; i++) {
      const theta = Math.random() * Math.PI * 2;
      const phi = Math.acos(2 * Math.random() - 1);
      const s = speed * (0.35 + Math.random() * 0.65);
      this.emit({
        ...options,
        position,
        velocity: {
          x: Math.sin(phi) * Math.cos(theta) * s,
          y: Math.sin(phi) * Math.sin(theta) * s,
          z: Math.cos(phi) * s,
        },
      });
    }
  }

  update(dt: number): void {
    for (let i = 0; i < this.count; ) {
      this.life[i] -= dt;
      if (this.life[i] <= 0) {
        this.swapRemove(i);
        continue;
      }

      const decay = Math.pow(this.drag[i], dt);
      this.vx[i] *= decay;
      this.vy[i] *= decay;
      this.vz[i] = this.vz[i] * decay - this.gravity[i] * dt;

      this.position[i * 3] += this.vx[i] * dt;
      this.position[i * 3 + 1] += this.vy[i] * dt;
      this.position[i * 3 + 2] += this.vz[i] * dt;

      const t = this.life[i] / this.maxLife[i];
      this.size[i] = this.endSize[i] + (this.startSize[i] - this.endSize[i]) * t;
      this.alpha[i] = t * t;
      i++;
    }

    const geo = this.points.geometry;
    geo.setDrawRange(0, this.count);
    (geo.attributes.position as THREE.BufferAttribute).needsUpdate = true;
    (geo.attributes.color as THREE.BufferAttribute).needsUpdate = true;
    (geo.attributes.particleSize as THREE.BufferAttribute).needsUpdate = true;
    (geo.attributes.particleAlpha as THREE.BufferAttribute).needsUpdate = true;
  }

  clear(): void {
    this.count = 0;
    this.points.geometry.setDrawRange(0, 0);
  }

  private swapRemove(i: number): void {
    const last = --this.count;
    if (i === last) return;
    for (let k = 0; k < 3; k++) {
      this.position[i * 3 + k] = this.position[last * 3 + k];
      this.color[i * 3 + k] = this.color[last * 3 + k];
    }
    this.vx[i] = this.vx[last];
    this.vy[i] = this.vy[last];
    this.vz[i] = this.vz[last];
    this.life[i] = this.life[last];
    this.maxLife[i] = this.maxLife[last];
    this.startSize[i] = this.startSize[last];
    this.endSize[i] = this.endSize[last];
    this.gravity[i] = this.gravity[last];
    this.drag[i] = this.drag[last];
    this.size[i] = this.size[last];
    this.alpha[i] = this.alpha[last];
  }
}
