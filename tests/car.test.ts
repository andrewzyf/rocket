import { describe, expect, it } from 'vitest';
import { Car, neutralInput, maxCurvature, throttleAccel, type CarInput } from '../src/physics/car';
import { field } from '../src/physics/field';
import { V } from '../src/core/math';
import {
  BOOST_CONSUMPTION,
  CAR_MAX_SPEED,
  SPAWN_Z,
  SUPERSONIC_THRESHOLD,
  TICK_DT,
} from '../src/core/constants';

function makeCar(): Car {
  const car = new Car();
  car.reset(V.make(0, -3000, SPAWN_Z), Math.PI / 2, 100);
  return car;
}

/**
 * Step the car, wrapping it back down the pitch when it nears the far wall.
 * The floor is uniform, so a shift along y is physically a no-op -- it just
 * gives the long acceleration tests an unbounded runway.
 */
function run(car: Car, input: Partial<CarInput>, seconds: number): void {
  const full = { ...neutralInput(), ...input };
  const ticks = Math.round(seconds / TICK_DT);
  for (let i = 0; i < ticks; i++) {
    car.step(full, TICK_DT, field);
    if (Math.abs(car.position.y) > 3000) {
      car.position = V.make(car.position.x, car.position.y - 6000 * Math.sign(car.position.y), car.position.z);
    }
  }
}

describe('throttle curve', () => {
  it('matches the measured knots', () => {
    expect(throttleAccel(0)).toBeCloseTo(1600, 3);
    expect(throttleAccel(1400)).toBeCloseTo(160, 3);
    expect(throttleAccel(1410)).toBeCloseTo(0, 3);
    expect(throttleAccel(2000)).toBe(0);
  });
});

describe('turn radius table', () => {
  it('tightens at low speed and loosens at high speed', () => {
    // Radius = 1 / curvature. Roughly 1.5 m at a crawl, ~11 m supersonic.
    expect(1 / maxCurvature(0)).toBeCloseTo(144.9, 0);
    expect(1 / maxCurvature(2300)).toBeGreaterThan(1000);
    // Monotonically loosening.
    for (let v = 0; v < 2300; v += 100) {
      expect(maxCurvature(v + 100)).toBeLessThan(maxCurvature(v));
    }
  });
});

describe('ground driving', () => {
  it('sits at ride height on the floor', () => {
    const car = makeCar();
    run(car, {}, 0.5);
    expect(car.onGround).toBe(true);
    // Sits at ride height, dipping under gravity plus sticky force for the
    // fraction of a tick between the re-seat and the next one.
    expect(car.position.z).toBeGreaterThan(SPAWN_Z - 0.5);
    expect(car.position.z).toBeLessThanOrEqual(SPAWN_Z);
  });

  it('accelerates on throttle and tops out at the published 1410 uu/s', () => {
    const car = makeCar();
    run(car, { throttle: 1 }, 1);
    // ~1 second in, well on the way but not yet at the cap.
    expect(car.forwardSpeed).toBeGreaterThan(900);
    expect(car.forwardSpeed).toBeLessThan(1410);
    run(car, { throttle: 1 }, 10);
    expect(car.forwardSpeed).toBeGreaterThan(1405);
    expect(car.forwardSpeed).toBeLessThanOrEqual(1411);
  });

  it('reaches supersonic on boost and never exceeds the hard cap', () => {
    const car = makeCar();
    run(car, { throttle: 1, boost: true }, 2.0);
    expect(car.speed).toBeGreaterThan(SUPERSONIC_THRESHOLD);
    expect(car.supersonic).toBe(true);
    run(car, { throttle: 1, boost: true }, 2);
    expect(car.speed).toBeLessThanOrEqual(CAR_MAX_SPEED + 1e-6);
  });

  it('drains the tank at 33.3 boost per second', () => {
    const car = makeCar();
    car.boost = 100;
    run(car, { throttle: 1, boost: true }, 1);
    expect(car.boost).toBeCloseTo(100 - BOOST_CONSUMPTION, 0);
  });

  it('stops boosting when the tank is empty', () => {
    const car = makeCar();
    car.boost = 0;
    run(car, { throttle: 1, boost: true }, 5);
    // Falls back to the throttle-only cap.
    expect(car.forwardSpeed).toBeLessThan(1420);
  });

  it('brakes at roughly 3500 uu/s^2', () => {
    const car = makeCar();
    run(car, { throttle: 1 }, 4);
    const before = car.forwardSpeed;
    run(car, { throttle: -1 }, 0.1);
    const decel = (before - car.forwardSpeed) / 0.1;
    expect(decel).toBeGreaterThan(3200);
    expect(decel).toBeLessThan(3800);
  });

  it('coasts down at roughly 525 uu/s^2', () => {
    const car = makeCar();
    run(car, { throttle: 1 }, 4);
    const before = car.forwardSpeed;
    run(car, { throttle: 0 }, 0.2);
    const decel = (before - car.forwardSpeed) / 0.2;
    expect(decel).toBeGreaterThan(450);
    expect(decel).toBeLessThan(600);
  });

  it('steers right when told to, and cannot turn from a standstill', () => {
    const still = makeCar();
    const headingBefore = Math.atan2(still.forward.y, still.forward.x);
    run(still, { steer: 1 }, 0.5);
    expect(Math.atan2(still.forward.y, still.forward.x)).toBeCloseTo(headingBefore, 4);

    const moving = makeCar();
    run(moving, { throttle: 1 }, 1);
    const before = Math.atan2(moving.forward.y, moving.forward.x);
    run(moving, { throttle: 1, steer: 1 }, 0.5);
    const after = Math.atan2(moving.forward.y, moving.forward.x);
    // Right turn = clockwise = decreasing heading in a right-handed Z-up frame.
    expect(after).toBeLessThan(before);
  });

  it('turns a full circle in about 3.1 seconds at full throttle and steer', () => {
    const car = makeCar();
    run(car, { throttle: 1 }, 2);
    let turned = 0;
    let prev = Math.atan2(car.forward.y, car.forward.x);
    const input = { ...neutralInput(), throttle: 1, steer: 1 };
    let t = 0;
    while (turned > -Math.PI * 2 && t < 8) {
      car.step(input, TICK_DT, field);
      t += TICK_DT;
      const now = Math.atan2(car.forward.y, car.forward.x);
      let d = now - prev;
      if (d > Math.PI) d -= Math.PI * 2;
      if (d < -Math.PI) d += Math.PI * 2;
      turned += d;
      prev = now;
    }
    expect(t).toBeGreaterThan(2.4);
    expect(t).toBeLessThan(4.0);
    // Settles near the published ~1234 uu/s cornering speed.
    expect(car.speed).toBeGreaterThan(1050);
    expect(car.speed).toBeLessThan(1400);
  });

  it('powerslides tighter than it can grip-turn, without dumping speed', () => {
    const grip = makeCar();
    const slide = makeCar();
    run(grip, { throttle: 1 }, 3);
    run(slide, { throttle: 1 }, 3);
    const entrySpeed = grip.speed;

    run(grip, { throttle: 1, steer: 1 }, 0.6);
    run(slide, { throttle: 1, steer: 1, handbrake: true }, 0.6);

    const gripTurn = Math.abs(Math.atan2(grip.forward.y, grip.forward.x));
    const slideTurn = Math.abs(Math.atan2(slide.forward.y, slide.forward.x));
    expect(slideTurn).toBeGreaterThan(gripTurn);
    // A powerslide is not a brake: most of the speed survives.
    expect(slide.speed).toBeGreaterThan(entrySpeed * 0.6);
  });
});

describe('jumping and dodging', () => {
  it('leaves the ground on a jump and gets higher when held', () => {
    const tap = makeCar();
    tap.step({ ...neutralInput(), jump: true }, TICK_DT, field);
    let tapPeak = tap.position.z;
    for (let i = 0; i < Math.round(1.2 / TICK_DT); i++) {
      tap.step(neutralInput(), TICK_DT, field);
      tapPeak = Math.max(tapPeak, tap.position.z);
    }

    const hold = makeCar();
    const held = { ...neutralInput(), jump: true };
    for (let i = 0; i < Math.round(0.2 / TICK_DT); i++) hold.step(held, TICK_DT, field);
    let peak = hold.position.z;
    for (let i = 0; i < Math.round(1.2 / TICK_DT); i++) {
      hold.step(neutralInput(), TICK_DT, field);
      peak = Math.max(peak, hold.position.z);
    }
    expect(tapPeak).toBeGreaterThan(SPAWN_Z + 20);
    expect(peak).toBeGreaterThan(tapPeak + 50);
  });

  it('front flips nose-down and adds forward speed', () => {
    const car = makeCar();
    run(car, { throttle: 1 }, 1);
    const speedBefore = car.speed;

    car.step({ ...neutralInput(), jump: true }, TICK_DT, field);
    run(car, {}, 0.1);
    expect(car.onGround).toBe(false);
    // Stick forward = pitch -1.
    car.step({ ...neutralInput(), jump: true, pitch: -1 }, TICK_DT, field);

    expect(car.speed).toBeGreaterThan(speedBefore + 300);
    // Nose pitching down means the forward vector's z is falling.
    run(car, { pitch: -1 }, 0.15);
    expect(car.forward.z).toBeLessThan(0);
  });

  it('backflips against the direction of travel and reverses the car', () => {
    const car = makeCar();
    run(car, { throttle: 1 }, 2);
    const heading = V.normalize(car.velocity);

    car.step({ ...neutralInput(), jump: true }, TICK_DT, field);
    run(car, {}, 0.1);
    car.step({ ...neutralInput(), jump: true, pitch: 1 }, TICK_DT, field);

    // The backward impulse eats the forward speed and pushes the other way.
    expect(V.dot(car.velocity, heading)).toBeLessThan(700);
  });

  it('double jumps flat when no direction is held', () => {
    const car = makeCar();
    car.step({ ...neutralInput(), jump: true }, TICK_DT, field);
    run(car, {}, 0.15);
    const vzBefore = car.velocity.z;
    car.step({ ...neutralInput(), jump: true }, TICK_DT, field);
    expect(car.velocity.z).toBeGreaterThan(vzBefore + 250);
    expect(car.doubleJumped).toBe(true);
  });

  it('spends the flip once per landing and re-arms on touchdown', () => {
    const car = makeCar();
    car.step({ ...neutralInput(), jump: true }, TICK_DT, field);
    run(car, {}, 0.15);
    car.step({ ...neutralInput(), jump: true }, TICK_DT, field); // flat double jump
    expect(car.canDodge).toBe(false);
    expect(car.doubleJumped).toBe(true);
    run(car, {}, 2.5);
    expect(car.onGround).toBe(true);
    expect(car.doubleJumped).toBe(false);
  });

  it('locks out the dodge window after 1.45 seconds', () => {
    const car = makeCar();
    car.step({ ...neutralInput(), jump: true }, TICK_DT, field);
    // Hang in the air long enough that the window expires.
    car.position = V.make(0, 0, 1500);
    car.velocity = V.zero();
    run(car, {}, 1.5);
    expect(car.canDodge).toBe(false);
  });
});

describe('air control', () => {
  function airborne(): Car {
    const car = new Car();
    car.reset(V.make(0, 0, 1200), 0, 100);
    car.onGround = false;
    return car;
  }

  it('rolls faster than it pitches, and pitches faster than it yaws', () => {
    const roll = airborne();
    const pitch = airborne();
    const yaw = airborne();
    run(roll, { roll: 1 }, 0.35);
    run(pitch, { pitch: 1 }, 0.35);
    run(yaw, { yaw: 1 }, 0.35);
    const rollRate = Math.abs(V.length(roll.angularVelocity));
    const pitchRate = Math.abs(V.length(pitch.angularVelocity));
    const yawRate = Math.abs(V.length(yaw.angularVelocity));
    expect(rollRate).toBeGreaterThan(pitchRate);
    expect(pitchRate).toBeGreaterThan(yawRate);
  });

  it('stops rotating when the stick is released', () => {
    const car = airborne();
    run(car, { pitch: 1 }, 0.4);
    const spinning = V.length(car.angularVelocity);
    expect(spinning).toBeGreaterThan(1);
    run(car, {}, 1.0);
    expect(V.length(car.angularVelocity)).toBeLessThan(spinning * 0.25);
  });

  it('boosts along the nose regardless of where the wheels point', () => {
    const car = airborne();
    run(car, { pitch: 1 }, 0.25); // nose up
    run(car, {}, 0.6); // let the damping settle the rotation
    expect(car.forward.z).toBeGreaterThan(0.3);

    // Compare against an identical car that coasts, so gravity cancels out.
    const control = airborne();
    run(control, { pitch: 1 }, 0.25);
    run(control, {}, 0.6);

    const nose = car.forward;
    run(car, { boost: true }, 0.3);
    run(control, {}, 0.3);
    const gained = V.dot(car.velocity, nose) - V.dot(control.velocity, nose);
    // ~1127 uu/s^2 along the nose for 0.3 s.
    expect(gained).toBeCloseTo(1127 * 0.3, -1);
  });

  it('never exceeds the angular velocity cap', () => {
    const car = airborne();
    run(car, { roll: 1 }, 3);
    expect(V.length(car.angularVelocity)).toBeLessThanOrEqual(5.5 + 1e-6);
  });
});
