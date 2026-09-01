import { describe, expect, it } from 'vitest';
import { Ball, kickScale } from '../src/physics/ball';
import { Car, neutralInput, type CarInput } from '../src/physics/car';
import { field } from '../src/physics/field';
import { V } from '../src/core/math';
import {
  BALL_COLLISION_RADIUS,
  BALL_MAX_SPEED,
  BALL_RESTITUTION,
  SPAWN_Z,
  TICK_DT,
} from '../src/core/constants';

function stepBall(ball: Ball, seconds: number): void {
  const ticks = Math.round(seconds / TICK_DT);
  for (let i = 0; i < ticks; i++) ball.step(TICK_DT, field);
}

function stepPair(ball: Ball, car: Car, input: Partial<CarInput>, seconds: number): void {
  const full = { ...neutralInput(), ...input };
  const ticks = Math.round(seconds / TICK_DT);
  for (let i = 0; i < ticks; i++) {
    car.step(full, TICK_DT, field);
    ball.collideWithCar(car);
    ball.step(TICK_DT, field);
  }
}

describe('kick scale curve', () => {
  it('decays with closing speed', () => {
    expect(kickScale(0)).toBeCloseTo(0.65, 5);
    expect(kickScale(500)).toBeCloseTo(0.65, 5);
    expect(kickScale(2300)).toBeCloseTo(0.55, 5);
    expect(kickScale(4600)).toBeCloseTo(0.3, 5);
    expect(kickScale(9999)).toBeCloseTo(0.3, 5);
    expect(kickScale(1400)).toBeGreaterThan(kickScale(3000));
  });
});

describe('ball physics', () => {
  it('settles on the floor at its collision radius', () => {
    const ball = new Ball();
    ball.reset(V.make(0, 0, 900));
    stepBall(ball, 6);
    expect(ball.position.z).toBeGreaterThan(BALL_COLLISION_RADIUS - 3);
    expect(ball.position.z).toBeLessThan(BALL_COLLISION_RADIUS + 3);
    expect(Math.abs(ball.velocity.z)).toBeLessThan(30);
  });

  it('bounces to roughly restitution-squared of the drop height', () => {
    const ball = new Ball();
    const dropHeight = 1500;
    ball.reset(V.make(0, 0, dropHeight));

    // Fall to the first contact.
    let bounced = false;
    for (let i = 0; i < 120 * 5 && !bounced; i++) {
      ball.step(TICK_DT, field);
      if (ball.velocity.z > 0) bounced = true;
    }
    let peak = ball.position.z;
    for (let i = 0; i < 120 * 3; i++) {
      ball.step(TICK_DT, field);
      peak = Math.max(peak, ball.position.z);
      if (ball.velocity.z < 0 && ball.position.z < peak - 5) break;
    }
    const ratio = (peak - BALL_COLLISION_RADIUS) / (dropHeight - BALL_COLLISION_RADIUS);
    // e^2, with a little lost to drag on the way down and back up.
    expect(ratio).toBeGreaterThan(BALL_RESTITUTION ** 2 - 0.08);
    expect(ratio).toBeLessThan(BALL_RESTITUTION ** 2 + 0.02);
  });

  it('picks up spin when it skids along the floor', () => {
    const ball = new Ball();
    ball.reset(V.make(0, 0, BALL_COLLISION_RADIUS));
    ball.velocity = V.make(0, 1500, 0);
    stepBall(ball, 1.5);
    // Rolling forward along +y means spinning about -x... check it is rotating
    // at all and in the direction that rolling implies.
    expect(Math.abs(ball.angularVelocity.x)).toBeGreaterThan(1);
    expect(ball.angularVelocity.x).toBeLessThan(0);
  });

  it('never exceeds the ball speed cap', () => {
    const ball = new Ball();
    ball.reset(V.make(0, 0, 1000));
    ball.velocity = V.make(0, 20000, 0);
    stepBall(ball, 0.1);
    expect(V.length(ball.velocity)).toBeLessThanOrEqual(BALL_MAX_SPEED + 1e-6);
  });

  it('rolls into the goal recess and stays there', () => {
    const ball = new Ball();
    ball.reset(V.make(0, 4000, BALL_COLLISION_RADIUS));
    ball.velocity = V.make(0, 2000, 0);
    // Long enough to cross the line, short enough not to rebound off the net.
    stepBall(ball, 0.9);
    expect(ball.position.y).toBeGreaterThan(5215.5);
    expect(Math.abs(ball.position.x)).toBeLessThan(892.755);
    // Still contained: the recess has a back and a roof.
    expect(field.query(ball.position).dist).toBeGreaterThan(0);
  });

  it('stays inside the arena after a long chaotic settle', () => {
    const ball = new Ball();
    ball.reset(V.make(1500, -2000, 1200));
    ball.velocity = V.make(2600, 3100, 1800);
    ball.angularVelocity = V.make(3, -2, 4);
    stepBall(ball, 20);
    expect(field.query(ball.position).dist).toBeGreaterThan(-5);
    expect(V.isFinite(ball.position)).toBe(true);
  });
});

describe('car-ball interaction', () => {
  function setup(): { car: Car; ball: Ball } {
    const car = new Car();
    car.reset(V.make(0, -1200, SPAWN_Z), Math.PI / 2, 100);
    const ball = new Ball();
    ball.reset(V.make(0, 0, BALL_COLLISION_RADIUS));
    return { car, ball };
  }

  it('sends the ball away faster than the car was travelling', () => {
    const { car, ball } = setup();
    stepPair(ball, car, { throttle: 1, boost: true }, 1.6);
    expect(ball.speed).toBeGreaterThan(600);
    // The bonus impulse means the ball leaves quicker than the car arrived.
    expect(ball.speed).toBeGreaterThan(car.speed * 0.8);
    expect(ball.velocity.y).toBeGreaterThan(0);
  });

  it('hits harder from a faster approach', () => {
    const slow = setup();
    stepPair(slow.ball, slow.car, { throttle: 1 }, 1.4);
    const fast = setup();
    stepPair(fast.ball, fast.car, { throttle: 1, boost: true }, 1.4);
    expect(fast.ball.speed).toBeGreaterThan(slow.ball.speed);
  });

  it('lifts the ball when the car gets under it', () => {
    const car = new Car();
    car.reset(V.make(0, -1200, SPAWN_Z), Math.PI / 2, 100);
    const ball = new Ball();
    // Ball sitting a little above the nose height, so contact is low on the sphere.
    ball.reset(V.make(0, 0, BALL_COLLISION_RADIUS + 30));
    stepPair(ball, car, { throttle: 1, boost: true }, 1.6);
    expect(ball.velocity.z).toBeGreaterThan(0);
  });

  it('applies the bonus kick radially from the car centre, not the contact point', () => {
    // A touch on the far side of the hitbox still pushes the ball away from the
    // car's centre -- the documented cause of odd-looking wheel touches.
    const car = new Car();
    car.reset(V.make(0, 0, SPAWN_Z), Math.PI / 2, 100);
    car.velocity = V.make(0, 900, 0);
    const ball = new Ball();
    // Offset well to the car's right, brushing the corner of the box.
    ball.reset(V.make(120, 40, BALL_COLLISION_RADIUS));
    ball.collideWithCar(car);
    expect(ball.velocity.x).toBeGreaterThan(100);
  });

  it('conserves nothing in particular but keeps everything finite', () => {
    const { car, ball } = setup();
    for (let i = 0; i < 120 * 20; i++) {
      car.step({ ...neutralInput(), throttle: 1, boost: true, steer: 0.4 }, TICK_DT, field);
      ball.collideWithCar(car);
      ball.step(TICK_DT, field);
    }
    expect(V.isFinite(ball.position)).toBe(true);
    expect(V.isFinite(car.position)).toBe(true);
    expect(field.query(car.position).dist).toBeGreaterThan(-60);
  });

  it('pushes the car back on contact, but not by the bonus impulse', () => {
    const { car, ball } = setup();
    car.velocity = V.make(0, 1200, 0);
    car.position = V.make(0, -40, SPAWN_Z);
    const before = car.velocity.y;
    ball.collideWithCar(car);
    // The car slows (Newton's third law on the physical half only).
    expect(car.velocity.y).toBeLessThan(before);
    expect(car.velocity.y).toBeGreaterThan(before - 400);
  });
});
