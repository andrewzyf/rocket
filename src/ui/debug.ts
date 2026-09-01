/**
 * Developer overlay. Kept in the shipped build behind F3 because the numbers it
 * shows -- velocity, boost, grounded state, flip availability -- are exactly
 * what you need to tune the physics constants against DESIGN.md, and guessing
 * from feel alone is how tuning goes wrong.
 */

import { V } from '../core/math';
import type { Car } from '../physics/car';
import type { Ball } from '../physics/ball';

export class DebugOverlay {
  readonly root = document.createElement('div');
  visible = false;

  private frameTimes: number[] = [];

  constructor() {
    this.root.className = 'debug';
    this.root.style.display = 'none';
  }

  toggle(): boolean {
    this.visible = !this.visible;
    this.root.style.display = this.visible ? '' : 'none';
    return this.visible;
  }

  update(car: Car, ball: Ball, frameMs: number, ticks: number): void {
    if (!this.visible) return;

    this.frameTimes.push(frameMs);
    if (this.frameTimes.length > 60) this.frameTimes.shift();
    const avg = this.frameTimes.reduce((a, b) => a + b, 0) / this.frameTimes.length;

    const flag = (on: boolean, label: string) =>
      `<span class="${on ? 'on' : 'off'}">${label}</span>`;

    const forwardSpeed = car.forwardSpeed;
    const lateral = V.dot(car.velocity, car.right);
    const yawRate = V.dot(car.angularVelocity, car.up);

    this.root.innerHTML =
      `<span class="k">fps  </span>${(1000 / Math.max(avg, 0.001)).toFixed(0)}  ` +
      `<span class="k">frame </span>${avg.toFixed(1)}ms  <span class="k">ticks </span>${ticks}\n` +
      `<span class="k">speed</span> ${car.speed.toFixed(0).padStart(4)} uu/s   ` +
      `<span class="k">fwd</span> ${forwardSpeed.toFixed(0).padStart(5)}  ` +
      `<span class="k">lat</span> ${lateral.toFixed(0).padStart(5)}\n` +
      `<span class="k">pos  </span>${car.position.x.toFixed(0).padStart(5)} ` +
      `${car.position.y.toFixed(0).padStart(5)} ${car.position.z.toFixed(0).padStart(5)}\n` +
      `<span class="k">yaw/s</span> ${yawRate.toFixed(2).padStart(5)} rad   ` +
      `<span class="k">|w|</span> ${V.length(car.angularVelocity).toFixed(2)}\n` +
      `<span class="k">boost</span> ${car.boost.toFixed(1).padStart(5)}\n` +
      `${flag(car.onGround, 'GROUND')} ${flag(!car.onGround, 'AIR')} ` +
      `${flag(car.canDodge, 'FLIP')} ${flag(car.isDodging, 'DODGING')} ` +
      `${flag(car.supersonic, 'SUPERSONIC')} ${flag(car.demolished, 'DEMO')}\n` +
      `<span class="k">wheels</span> ${car.wheels.map((w) => (w.touching ? '#' : '.')).join('')}\n` +
      `<span class="k">ball </span>${ball.speed.toFixed(0).padStart(4)} uu/s  ` +
      `z ${ball.position.z.toFixed(0).padStart(4)}  ` +
      `<span class="k">spin</span> ${V.length(ball.angularVelocity).toFixed(2)}`;
  }
}
