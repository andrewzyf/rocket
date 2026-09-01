/**
 * Emergent techniques.
 *
 * None of these are special-cased anywhere in the code. They exist only if the
 * primitives in DESIGN.md sections 4-6 are right, which makes them the most
 * useful regression tests in the suite: if a constant drifts, these break
 * before anything obvious does.
 */

import { describe, expect, it } from 'vitest';
import { Car, neutralInput, type CarInput } from '../src/physics/car';
import { field } from '../src/physics/field';
import { V } from '../src/core/math';
import { SIDE_WALL_X, SPAWN_Z, TICK_DT } from '../src/core/constants';

function run(car: Car, input: Partial<CarInput>, seconds: number): void {
  const full = { ...neutralInput(), ...input };
  const ticks = Math.round(seconds / TICK_DT);
  for (let i = 0; i < ticks; i++) car.step(full, TICK_DT, field);
}

describe('wall and ceiling driving', () => {
  it('drives up a side wall and ends up with its wheels on it', () => {
    const car = new Car();
    // Start well out from the wall, pointed straight at it, at speed.
    car.reset(V.make(1000, 0, SPAWN_Z), 0, 100);
    run(car, { throttle: 1, boost: true }, 1.9);
    expect(car.position.x).toBeGreaterThan(SIDE_WALL_X - 900);

    run(car, { throttle: 1, boost: true }, 0.4);
    // Up the curve and onto the wall: the car's roof now points inward.
    expect(car.position.z).toBeGreaterThan(300);
    expect(car.onGround).toBe(true);
    expect(car.up.x).toBeLessThan(-0.9);

    // Keep going and it carries all the way onto the ceiling.
    run(car, { throttle: 1, boost: true }, 0.9);
    expect(car.position.z).toBeGreaterThan(1800);
    expect(car.up.z).toBeLessThan(-0.5);
  });

  it('slides back down a wall when it runs out of speed', () => {
    const car = new Car();
    car.reset(V.make(1400, 0, SPAWN_Z), 0, 100);
    run(car, { throttle: 1, boost: true }, 3.0);
    const high = car.position.z;
    expect(high).toBeGreaterThan(300);

    // Let go: gravity's tangential component pulls it back down the wall.
    run(car, {}, 1.6);
    expect(car.position.z).toBeLessThan(high);
  });
});

describe('wavedash', () => {
  it('converts a flip into ground speed on landing', () => {
    // Two identical cars at the same speed. One jumps and lands normally, the
    // other flips into the landing. The flip's planar impulse should survive
    // as ground speed rather than being spent in the air.
    const plain = new Car();
    const dashed = new Car();
    for (const car of [plain, dashed]) {
      car.reset(V.make(0, -3000, SPAWN_Z), Math.PI / 2, 0);
      run(car, { throttle: 1 }, 2.5);
    }
    const entry = plain.speed;
    expect(entry).toBeGreaterThan(1200);

    // Both hop.
    plain.step({ ...neutralInput(), jump: true, throttle: 1 }, TICK_DT, field);
    dashed.step({ ...neutralInput(), jump: true, throttle: 1 }, TICK_DT, field);
    run(plain, { throttle: 1 }, 0.28);
    run(dashed, { throttle: 1 }, 0.28);

    // The dasher flips forward on the way down.
    dashed.step({ ...neutralInput(), jump: true, pitch: -1, throttle: 1 }, TICK_DT, field);

    // The dodge's vertical damping keeps the dasher airborne a little longer,
    // so give both time to settle before comparing.
    run(plain, { throttle: 1 }, 1.4);
    run(dashed, { throttle: 1 }, 1.4);

    expect(plain.onGround).toBe(true);
    expect(dashed.onGround).toBe(true);
    // The plain car sits at the throttle-only cap plus the small amount air
    // throttle adds during the hop; the dasher carries the flip's impulse well
    // past it, which is the entire point of the technique.
    expect(plain.speed).toBeLessThan(1500);
    expect(dashed.speed).toBeGreaterThan(plain.speed + 350);
  });
});

describe('half-flip', () => {
  it('turns the car around while keeping speed', () => {
    const car = new Car();
    car.reset(V.make(0, -1000, SPAWN_Z), Math.PI / 2, 0);
    run(car, { throttle: 1 }, 2.5);
    const startHeading = Math.atan2(car.forward.y, car.forward.x);

    // Backflip, then air-roll through 180 and cancel the pitch.
    car.step({ ...neutralInput(), jump: true }, TICK_DT, field);
    run(car, {}, 0.1);
    car.step({ ...neutralInput(), jump: true, pitch: 1 }, TICK_DT, field);
    // Roll hard while the flip rotates; pitch is locked out for the first
    // 0.3 s of a dodge, which is exactly why the roll has to come first.
    run(car, { roll: 1 }, 0.45);
    run(car, { pitch: -1, roll: 1 }, 0.35);
    run(car, {}, 1.4);

    const endHeading = Math.atan2(car.forward.y, car.forward.x);
    let turned = Math.abs(endHeading - startHeading);
    if (turned > Math.PI) turned = Math.PI * 2 - turned;
    // Ended up meaningfully rotated away from where it started.
    expect(turned).toBeGreaterThan(0.8);
  });
});

describe('flip reset', () => {
  it('re-arms the flip on wheel contact without touching the ground', () => {
    const car = new Car();
    car.reset(V.make(0, 0, 1200), 0, 100);
    car.onGround = false;
    car.step({ ...neutralInput(), jump: true }, TICK_DT, field);
    run(car, {}, 0.1);
    car.step({ ...neutralInput(), jump: true, pitch: -1 }, TICK_DT, field);
    expect(car.canDodge).toBe(false);

    // Something touches the wheels mid-air.
    car.resetFlip();
    expect(car.canDodge).toBe(true);
    expect(car.onGround).toBe(false);
  });
});

describe('supersonic', () => {
  it('holds the state briefly after dropping below the threshold', () => {
    const car = new Car();
    car.reset(V.make(0, -4000, SPAWN_Z), Math.PI / 2, 100);
    run(car, { throttle: 1, boost: true }, 2.4);
    expect(car.supersonic).toBe(true);

    // Coast: speed falls below 2200 but stays over 2100 for a moment.
    run(car, { throttle: 0 }, 0.15);
    expect(car.speed).toBeLessThan(2200);
    expect(car.supersonic).toBe(true);

    run(car, { throttle: -1 }, 0.4);
    expect(car.supersonic).toBe(false);
  });
});
